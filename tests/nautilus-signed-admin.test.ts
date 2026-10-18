/**
 * A node's own admin routes — plan item A9 (remainder), findings A-14 and AUTH-14.
 *
 * A real NautilusAppServer with its own bearer token and one registered client key. The bearer
 * and the signature are alternatives; the signature is verified over the body actually received,
 * so the forged `X-Content-Hash` that the previous verifier trusted is refused; a replay is
 * refused; and the handler receives the body the gate read.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex, contentHashOf } from '../src/security/signed-request.js';

jest.setTimeout(30_000);

const TOKEN = 'employer-own-admin-token';
const hrTool = generateNodeKey('hr-tool-1');
const impostor = generateNodeKey('hr-tool-2');
let server: NautilusAppServer;
let url: string;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9b-node-'));
  const config = {
    role: 'employer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1',
    stateDir: dir, enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: TOKEN,
  } as unknown as NautilusAppConfig;
  server = new NautilusAppServer(config);
  server.registerRoutes([
    { method: 'POST', path: '/admin/echo', adminOnly: true, handler: async (_req, res, _p, _q, body) => server.sendResponse(res, 200, true, { body }) },
    { method: 'GET', path: '/admin/ping', adminOnly: true, handler: async (_req, res) => server.sendResponse(res, 200, true, { pong: true }) },
    { method: 'GET', path: '/open', handler: async (_req, res) => server.sendResponse(res, 200, true, { open: true }) },
  ]);
  server.registerClientKey(hrTool.nodeId, hrTool.publicKeyHex);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => {
  await server.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const signed = (key: { nodeId: string; seedHex: string }, method: string, p: string, body?: string) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method, path: p, body });

async function call(method: string, p: string, headers: Record<string, string>, body?: string) {
  const r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}

test('the node\'s own bearer works, and keeps working after a client key is registered', async () => {
  const r = await call('POST', '/admin/echo', { Authorization: `Bearer ${TOKEN}` }, '{"x":1}');
  expect(r.status).toBe(200);
  expect(r.json.data.body).toEqual({ x: 1 });
  const bad = await call('POST', '/admin/echo', { Authorization: 'Bearer nope' }, '{"x":1}');
  expect(bad.status).toBe(401);
});

test('a registered client key signs a request the node accepts, and the handler sees the signed body', async () => {
  const body = JSON.stringify({ groupId: 'G1', planId: 'P1' });
  const r = await call('POST', '/admin/echo', signed(hrTool, 'POST', '/admin/echo', body), body);
  expect(r.status).toBe(200);
  expect(r.json.data.body).toEqual({ groupId: 'G1', planId: 'P1' });
  const get = await call('GET', '/admin/ping', signed(hrTool, 'GET', '/admin/ping'));
  expect(get.status).toBe(200);
});

test('AUTH-14: a signature over the caller\'s own content hash is refused when the body differs', async () => {
  const claimed = JSON.stringify({ groupId: 'G1', enrollmentCap: 10 });
  const sent = JSON.stringify({ groupId: 'G1', enrollmentCap: 10_000 });
  // The signer signs a hash of `claimed`, declares that hash in X-Content-Hash, and sends `sent`.
  const headers = signed(hrTool, 'POST', '/admin/echo', claimed);
  expect(headers['X-Content-Hash']).toBe(contentHashOf(claimed));
  const r = await call('POST', '/admin/echo', headers, sent);
  expect(r.status).toBe(401);
});

test('a replayed signature, an unregistered key, another path and an unsigned call are all 401', async () => {
  const body = '{"once":true}';
  const headers = signed(hrTool, 'POST', '/admin/echo', body);
  expect((await call('POST', '/admin/echo', headers, body)).status).toBe(200);
  expect((await call('POST', '/admin/echo', headers, body)).status).toBe(401);
  expect((await call('POST', '/admin/echo', signed(impostor, 'POST', '/admin/echo', body), body)).status).toBe(401);
  expect((await call('POST', '/admin/echo', signed(hrTool, 'POST', '/admin/other', body), body)).status).toBe(401);
  expect((await call('POST', '/admin/echo', {}, body)).status).toBe(401);
});

test('revoking the key closes the signature path and leaves the bearer and open routes alone', async () => {
  expect(server.listClientKeys()).toEqual([{ clientId: 'hr-tool-1', publicKeyHex: hrTool.publicKeyHex }]);
  expect(server.revokeClientKey('hr-tool-1')).toBe(true);
  expect((await call('GET', '/admin/ping', signed(hrTool, 'GET', '/admin/ping'))).status).toBe(401);
  expect((await call('GET', '/admin/ping', { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  expect((await call('GET', '/open', {})).status).toBe(200);
});

test('a node without a key sends no sequencer credential; with one it signs the exact bytes', () => {
  expect(server.sequencerAuthHeaders('POST', '/rpc', '{}')).toEqual({});
  const keyed = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: TOKEN,
    nodeKey: { nodeId: 'insurer', seedHex: hrTool.seedHex },
  } as unknown as NautilusAppConfig);
  const headers = keyed.sequencerAuthHeaders('POST', '/rpc', '{"jsonrpc":"2.0"}');
  expect(headers['X-Admin-Signature']).toMatch(/^insurer:\d+:[0-9a-f]{128}$/);
  expect(headers['X-Content-Hash']).toBe(contentHashOf('{"jsonrpc":"2.0"}'));
  expect(headers.Authorization).toBeUndefined();
});
