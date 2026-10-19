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
 * The engine's routes that make proofs refuse with 503 while its provers start, and an open read says when they can.
 *
 * What was wrong: the engine accepted proving requests while its proof pool was still compiling. In the single-member
 * run of 2026-10-19 the first prescription arrived through the prescriber node about 150 s before the pool was ready;
 * its first proof waited 148.87 s inside the request, the request outlasted its 180 s budget, the node reported
 * "Request timeout" and the dashboard path failed, though the engine finished the prescription later.
 *
 * Now GET /interactive/ready answers { ready, compiled, prover } to anyone (200 when ready, 503 with Retry-After when
 * not), and every route whose handler reaches the prover answers 503 with Retry-After and "The claims engine is still
 * starting its provers; try again shortly." until the engine is ready, before it reads its body, takes the proving lock
 * or changes anything. Which routes those are is checked against the code: every POST route whose handler calls a
 * service method that reaches dispatchProof.
 *
 * A real sequencer server with a stand-in engine that records every call made to it.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes, PROVERS_STARTING_MESSAGE, PROVERS_RETRY_AFTER_SECONDS } from '../src/adjudication/interactive-routes.js';
import { generateNodeKey, ROUTES_BY_ROLE } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const prescriberNode = generateNodeKey('prescriber-node');

let server: L2RpcServer;
let url: string;
/** What the stand-in engine says about its readiness. Its summary also carries member data, which must not be served. */
let readiness: { ready: boolean; compiled: boolean; prover: string } = { ready: false, compiled: true, prover: 'starting' };
/** Every engine method a handler called, and the proving lock when it was taken. */
const touched: string[] = [];

function standInEngine() {
  const l2 = { withProvingLock: (fn: () => Promise<unknown>) => { touched.push('withProvingLock'); return Promise.resolve().then(fn); } };
  const own: Record<string, unknown> = {
    isProvingReady: () => readiness.ready,
    provingReadiness: () => ({ ...readiness, walletId: '424242424242', members: [{ displayName: 'Avery' }] }),
    getState: () => { touched.push('getState'); return { compiled: true, enrolledMembers: [] }; },
    getL2Node: () => { touched.push('getL2Node'); return l2; },
    createPrescription: async () => { touched.push('createPrescription'); return { prescriptionId: 'RX-READY' }; },
    dispensePrescription: async () => { touched.push('dispensePrescription'); return { prescriptionId: 'RX-READY', adjudication: {} }; },
    forceBatch: async () => { touched.push('forceBatch'); },
  };
  return new Proxy(own, {
    get(t, p) {
      if (p in t) return t[p as string];
      return typeof p === 'string' && p !== 'then' ? (..._args: unknown[]) => { touched.push(p); return undefined; } : undefined;
    },
  });
}

/** The routes that make proofs, each with a body its handler accepts. */
const PROVING: Array<[string, Record<string, unknown>]> = [
  ['/interactive/enroll', { memberIndex: 0 }],
  ['/interactive/enroll-family', { subscriberIndex: 0 }],
  ['/interactive/approve-prior-auth', { priorAuthId: 'PA-0001' }],
  ['/interactive/prescribe', { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: '1', ndcHash: '1', quantity: 30, refills: 0 }],
  ['/interactive/fill', { prescriptionId: 'RX-STARTING' }],
  ['/interactive/prescribe-and-fill', { memberWalletId: '1', ndcHash: '1', prescriberIndex: 0, pharmacyIndex: 0 }],
  ['/interactive/reverse', { prescriptionId: 'RX-STARTING' }],
  ['/interactive/assign-pcp', { memberWalletId: '1', prescriberIndex: 0 }],
  ['/interactive/send-message', { senderType: 'member', recipientType: 'prescriber', subject: 's', body: 'b' }],
  ['/interactive/create-delegation', { delegatorWalletId: '1', delegateWalletId: '2', scopeFlags: 1, relationshipCode: 1 }],
  ['/interactive/generate-credential', { walletId: '1', proofType: 'holding' }],
  ['/interactive/update-formulary', { ndcHash: '1', action: 'MODIFY' }],
  ['/interactive/update-provider-network', { prescriberWalletId: '1', action: 'ADD' }],
  ['/interactive/plan-year-rollover', { newPlanYear: '2027' }],
  ['/interactive/badge/tap', { providerType: 'prescriber', providerIndex: 0 }],
  ['/interactive/badge/auto-tap', { includePharmacies: false }],
];

async function post(p: string, body: unknown, headers: Record<string, string> = bearer) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, retryAfter: r.headers.get('retry-after'), json };
}
async function get(p: string, headers: Record<string, string> = {}) {
  const r = await fetch(url + p, { headers });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, retryAfter: r.headers.get('retry-after'), json };
}

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-engine-ready' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  registerInteractiveRoutes(server, standInEngine() as any);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server.stop(); });

beforeEach(() => { touched.length = 0; });

describe('GET /interactive/ready', () => {
  test('answers anyone, with no credential: 503 and Retry-After while the provers start, 200 once the engine can prove', async () => {
    readiness = { ready: false, compiled: true, prover: 'starting' };
    const starting = await get('/interactive/ready');
    expect(starting.status).toBe(503);
    expect(starting.retryAfter).toBe(String(PROVERS_RETRY_AFTER_SECONDS));
    expect(starting.json).toEqual({ ready: false, compiled: true, prover: 'starting' });

    readiness = { ready: true, compiled: true, prover: 'pool' };
    const ready = await get('/interactive/ready');
    expect(ready.status).toBe(200);
    expect(ready.retryAfter).toBeNull();
    expect(ready.json).toEqual({ ready: true, compiled: true, prover: 'pool' });
  });

  test('an engine still compiling its programs reads as not ready too', async () => {
    readiness = { ready: false, compiled: false, prover: 'inline' };
    const r = await get('/interactive/ready');
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBe(String(PROVERS_RETRY_AFTER_SECONDS));
    expect(r.json).toEqual({ ready: false, compiled: false, prover: 'inline' });
  });

  test('serves the summary only: nothing about members, whatever else the engine holds', async () => {
    readiness = { ready: true, compiled: true, prover: 'inline' };
    const r = await get('/interactive/ready');
    expect(Object.keys(r.json).sort()).toEqual(['compiled', 'prover', 'ready']);
    expect(JSON.stringify(r.json)).not.toMatch(/424242424242|Avery|walletId|members/);
  });

  test('is declared one of the engine\'s open reads, and nothing puts it behind a gate', () => {
    const src = fs.readFileSync('src/adjudication/interactive-routes.ts', 'utf-8').replace(/\r\n/g, '\n');
    const setOf = (name: string) => {
      const start = src.indexOf(`const ${name} = new Set([`);
      expect([name, start > 0]).toEqual([name, true]);
      return src.slice(start, src.indexOf(']);', start));
    };
    expect(setOf('OPEN_READS')).toContain("'/interactive/ready'");
    expect(setOf('ADMIN_ROUTES')).not.toContain("'/interactive/ready'");
    expect(setOf('GATED_READS')).not.toContain("'/interactive/ready'");
    for (const [role, routes] of Object.entries(ROUTES_BY_ROLE)) expect([role, routes.has('GET:/interactive/ready')]).toEqual([role, false]);
  });
});

describe('the routes that make proofs, while the provers start', () => {
  beforeEach(() => { readiness = { ready: false, compiled: true, prover: 'starting' }; });

  test('each answers 503 with Retry-After and the message, and touches nothing: no engine call, no proving lock', async () => {
    for (const [p, body] of PROVING) {
      touched.length = 0;
      const r = await post(p, body);
      expect([p, r.status, r.retryAfter]).toEqual([p, 503, String(PROVERS_RETRY_AFTER_SECONDS)]);
      expect([p, r.json?.error]).toEqual([p, PROVERS_STARTING_MESSAGE]);
      expect([p, r.json?.retryAfterSeconds]).toEqual([p, PROVERS_RETRY_AFTER_SECONDS]);
      expect([p, touched]).toEqual([p, []]);
    }
    expect(PROVERS_STARTING_MESSAGE).toBe('The claims engine is still starting its provers; try again shortly.');
  });

  test('a refused request leaves no job behind: the fill, the enrollment and the credential were never started', async () => {
    await post('/interactive/fill', { prescriptionId: 'RX-NO-JOB' });
    await post('/interactive/enroll', { memberIndex: 3 });
    await post('/interactive/generate-credential', { walletId: '77', proofType: 'holding' });
    expect((await get('/interactive/fill-status?prescriptionId=RX-NO-JOB', bearer)).json).toEqual({ status: 'not_started' });
    expect((await get('/interactive/enroll-status?memberIndex=3', bearer)).json).toEqual({ status: 'not_started' });
    expect((await get('/interactive/credential-status?walletId=77&proofType=holding', bearer)).json).toEqual({ status: 'not_started' });
  });

  test('a prescriber node signed with its own key gets the same 503, after its credential is checked', async () => {
    const p = '/interactive/prescribe';
    const body = PROVING.find(([path]) => path === p)![1];
    const headers = signRequest({ signerId: prescriberNode.nodeId, privateKey: privateKeyFromSeedHex(prescriberNode.seedHex), method: 'POST', path: p, body: JSON.stringify(body) });
    const r = await post(p, body, headers);
    expect([r.status, r.json?.error]).toEqual([503, PROVERS_STARTING_MESSAGE]);
    expect((await post(p, body, {})).status).toBe(401); // no credential: refused by the gate first, as before
    expect(touched).toEqual([]);
  });

  test('routes that make no proof answer as before', async () => {
    for (const [p, body] of [
      ['/interactive/resolve-indices', { prescriberWalletId: '1' }],
      ['/interactive/deny-prior-auth', { priorAuthId: 'PA-0001' }],
      ['/interactive/mark-filled', { prescriptionId: 'RX-1' }],
      ['/interactive/register-member', {}],
      ['/interactive/verify-credential', { credentialJson: '{}' }],
      ['/interactive/approve-member', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect([p, (await post(p, body)).status === 503]).toEqual([p, false]);
    }
  });
});

describe('once the engine is ready to prove', () => {
  beforeEach(() => { readiness = { ready: true, compiled: true, prover: 'pool' }; });

  test('a prescription reaches the engine under the proving lock, and a fill starts its job', async () => {
    const rx = await post('/interactive/prescribe', PROVING.find(([p]) => p === '/interactive/prescribe')![1]);
    expect(rx.status).toBe(200);
    expect(rx.json).toEqual({ prescriptionId: 'RX-READY' });
    expect(touched).toEqual(expect.arrayContaining(['withProvingLock', 'createPrescription']));
    const fill = await post('/interactive/fill', { prescriptionId: 'RX-READY-FILL' });
    expect(fill.status).toBe(202);
    expect(['pending', 'complete']).toContain((await get('/interactive/fill-status?prescriptionId=RX-READY-FILL', bearer)).json?.status);
  });
});

describe('which routes wait for the provers', () => {
  const routesSrc = fs.readFileSync('src/adjudication/interactive-routes.ts', 'utf-8').replace(/\r\n/g, '\n');
  const serviceSrc = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf-8').replace(/\r\n/g, '\n');

  /** The engine methods that reach dispatchProof, directly or through other engine methods. */
  function provingMethods(): Set<string> {
    const lines = serviceSrc.split('\n');
    const decl = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/;
    const enclosing = (i: number): string | null => {
      for (let j = i; j >= 0; j--) {
        const m = lines[j].match(decl);
        if (m && !/^(if|for|while|switch|return|catch)$/.test(m[1])) return m[1];
      }
      return null;
    };
    const reach = new Set<string>(['dispatchProof']);
    for (let grew = true; grew;) {
      grew = false;
      lines.forEach((line, i) => {
        for (const m of [...reach]) {
          if (!line.includes(`this.${m}(`)) continue;
          const caller = enclosing(i);
          if (caller && !reach.has(caller)) { reach.add(caller); grew = true; }
        }
      });
    }
    reach.delete('dispatchProof');
    return reach;
  }

  /** Each POST route this file registers, with the engine methods its handler calls. */
  function postRoutes(): Map<string, Set<string>> {
    const starts = [...routesSrc.matchAll(/reg\('([A-Z]+)',\s*'([^']+)'/g)];
    const out = new Map<string, Set<string>>();
    starts.forEach((m, k) => {
      if (m[1] !== 'POST') return;
      const block = routesSrc.slice(m.index!, k + 1 < starts.length ? starts[k + 1].index! : routesSrc.length);
      out.set(m[2], new Set([...block.matchAll(/service\.(\w+)\(/g)].map((c) => c[1])));
    });
    return out;
  }

  function provingRouteSet(): Set<string> {
    const start = routesSrc.indexOf('const PROVING_ROUTES = new Set([');
    expect(start).toBeGreaterThan(0);
    return new Set([...routesSrc.slice(start, routesSrc.indexOf(']);', start)).matchAll(/'(\/interactive\/[^']+)'/g)].map((m) => m[1]));
  }

  /**
   * The one route whose handler reaches the prover only through a path it never takes: assignPcpForDevice refuses a
   * console member (the engine holds the identity preimage only for those) and queues the device's wallet update, which
   * the member's device proves. It makes no proof, so it does not wait for the provers.
   */
  const NO_PROOF = new Map([['/interactive/pcp-assignment', 'A fixture member is assigned a primary-care prescriber through the console']]);

  test('every POST route whose handler reaches the prover waits for it, and nothing else does', () => {
    const proving = provingMethods();
    for (const m of ['createPrescription', 'dispensePrescription', 'reversePrescription', 'approvePriorAuth']) expect([m, proving.has(m)]).toEqual([m, true]);
    const reaching = [...postRoutes()].filter(([, calls]) => [...calls].some((c) => proving.has(c))).map(([p]) => p);
    const expected = reaching.filter((p) => !NO_PROOF.has(p)).sort();
    expect([...provingRouteSet()].sort()).toEqual(expected);
    expect(PROVING.map(([p]) => p).sort()).toEqual(expected);
  });

  test('the route left out still makes no proof: the device proves its own wallet update', () => {
    for (const [route, refusal] of NO_PROOF) {
      expect([route, postRoutes().has(route)]).toEqual([route, true]);
      expect([route, serviceSrc.includes(refusal)]).toEqual([route, true]);
    }
  });

  test('the registration helper puts the readiness gate on every route in the set', () => {
    expect(routesSrc).toContain("const route = upper === 'POST' && PROVING_ROUTES.has(path) ? untilProvingReady(upper, path, handler) : handler;");
    expect(routesSrc).toContain('server.registerRoute(method, path, route, adminOnly ?');
    expect(routesSrc).toContain('server.registerRoute(method, path, route, timeoutMs ? { providerSigned, timeoutMs } : { providerSigned });');
  });
});
