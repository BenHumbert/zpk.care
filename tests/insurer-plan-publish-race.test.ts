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
 * The insurer's plan store after plan-bound formularies: publishing while an edit lands, the amounts a plan may hold,
 * and plans published before the published terms were kept (pricing review F5, F9 and F11).
 *
 * What was wrong:
 *  F5. markPlanPublished read the live record again and marked it published. A draft saved while the publish route
 *      waited on the sequencer's overlay call was labelled published, though members are billed the terms that were
 *      read before it (publishedTerms) and the draft's values were never published.
 *  F9. POST and PUT /plans checked only the copay and the fee: a negative or fractional deductible, OOP max, annual
 *      max or family limit reached the plan store, and on POST it made the auto-publish fail.
 *  F11. Nothing named the plans marked published that carry no published terms (published before the terms were
 *      kept): the engine refuses their members with 409 while every screen called them published.
 *
 * Now the live record is marked published only if it is still the version that was published, and the route says when
 * a newer draft is pending; both routes refuse such amounts and keep 0, which means none or no limit; and the insurer
 * node names each plan that must be published again, one log line with its ID and name.
 *
 * The insurer's routes over a real sequencer RPC server, the insurer node signing as itself, with the overlay call held
 * open while an edit is saved. The formulary is cut to 100 drugs before anything loads src/data.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(180_000);

const OPERATOR = 'operator-token-for-publish-race';
let rpcServer: any;
let seq: any;
let seqUrl: string;
let routes: any[];
let insurer: any;
let ndcA: string;
/** Run once, inside the publish route, while its l2_publishPlanOverlay call is in flight. */
let duringOverlay: (() => Promise<void>) | null = null;
const tempDirs: string[] = [];

interface Captured { status: number; payload: any }
async function call(method: string, p: string, args: { params?: Record<string, string>; body?: unknown } = {}): Promise<Captured> {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route not registered: ${method} ${p}`);
  let status = 0;
  let payload: any = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(body?: string) { if (body) { try { payload = JSON.parse(body); } catch { payload = { raw: body }; } } return this; },
    get writableEnded() { return status !== 0; },
  };
  await r.handler({ url: p, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, args.params ?? {}, new URLSearchParams(), args.body);
  return { status, payload };
}
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${seqUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
const planBody = (planId: string, over: Record<string, unknown> = {}) => ({ planId, name: planId, copayAmountCents: 1500, formularyNdcs: [ndcA], ...over });

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
  const { InsurerNode } = await import('../src/nodes/insurer-node.js');
  const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  ndcA = getAllFormularyEntries()[3].ndc;

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-publish-race' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  const insurerKey = generateNodeKey('insurer-node');
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
  await rpcServer.start();
  seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-race-'));
  tempDirs.push(dir);
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: 'admin-token-for-tests', nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
  } as any);
  // Hold the publish route's overlay call open while a test saves an edit, as a second admin would.
  const forward = server.signedFetch.bind(server);
  (server as any).signedFetch = async (url: string, init: any) => {
    let method: string | undefined;
    try { method = JSON.parse(String(init?.body ?? '{}')).method; } catch { method = undefined; }
    if (method === 'l2_publishPlanOverlay' && duringOverlay) {
      const hook = duringOverlay;
      duringOverlay = null;
      await hook();
    }
    return forward(url, init);
  };
  insurer = new InsurerNode({ role: 'insurer', sequencerUrl: seqUrl, displayName: 'Insurer', clientOptions: server.sequencerClientOptions() } as any);
  server.setEntityNode(insurer);
  routes = buildInsurerRoutes(server);
});

afterAll(async () => {
  await rpcServer?.stop();
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('F5: publishing while an edit is saved', () => {
  test('a draft saved while the overlay call is pending stays a draft; the published terms are the version read at publish', async () => {
    expect((await call('POST', '/plans', { body: planBody('PLAN-RACE-1') })).status).toBe(201);
    // Admin A sets a $5 fee and publishes; while the route waits on the sequencer, admin B saves a $90 fee.
    expect((await call('PUT', '/plans/:planId', { params: { planId: 'PLAN-RACE-1' }, body: { dispensingFeeCents: 500 } })).status).toBe(200);
    duringOverlay = async () => {
      const edit = await call('PUT', '/plans/:planId', { params: { planId: 'PLAN-RACE-1' }, body: { dispensingFeeCents: 9000 } });
      expect(edit.status).toBe(200);
    };
    const published = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-RACE-1' } });
    expect(duringOverlay).toBeNull();   // the edit ran inside the publish
    expect(published.status).toBe(200);
    expect(published.payload.data).toMatchObject({ published: false, draftPending: true });
    expect(published.payload.data.message).toMatch(/newer draft/);

    const stored = seq.getPlan('PLAN-RACE-1');
    expect(stored.published).toBe(false);                       // before: true, labelling the $90 draft as published
    expect(stored.dispensingFeeCents).toBe(9000);               // the draft is kept, unpublished
    expect(stored.publishedTerms.dispensingFeeCents).toBe(500); // members are billed what was published
    expect(stored.formularyRoot).toBe(stored.publishedTerms.formularyRoot);
  });

  test('publishing again with nothing saved in between publishes the draft and marks it published', async () => {
    const r = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-RACE-1' } });
    expect(r.status).toBe(200);
    expect(r.payload.data).toMatchObject({ published: true, draftPending: false });
    expect(r.payload.data.message).toBeUndefined();
    const stored = seq.getPlan('PLAN-RACE-1');
    expect(stored.published).toBe(true);
    expect(stored.publishedTerms.dispensingFeeCents).toBe(9000);
  });

  test('an edit that changes no binding field (the name) leaves the published version published', async () => {
    duringOverlay = async () => {
      expect((await call('PUT', '/plans/:planId', { params: { planId: 'PLAN-RACE-1' }, body: { name: 'Renamed while publishing' } })).status).toBe(200);
    };
    const r = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-RACE-1' } });
    expect(r.payload.data).toMatchObject({ published: true, draftPending: false });
    const stored = seq.getPlan('PLAN-RACE-1');
    expect(stored.published).toBe(true);
    expect(stored.name).toBe('Renamed while publishing');
  });

  test('an edit that carries the published version\'s updatedAt is still a draft: only the binding fields decide', async () => {
    // Two PUTs stamped in the same millisecond, or a direct l2_storePlan that keeps the stamp, give an edit the updatedAt
    // of the version being published. markPlanPublished took an equal updatedAt as proof that nothing had changed.
    const source = JSON.parse(JSON.stringify(seq.getPlan('PLAN-RACE-1')));   // the version the publish route read
    const edit = { ...source, dispensingFeeCents: 9900, published: false };   // same updatedAt, another fee
    expect((await rpc('l2_storePlan', { plan: edit })).error).toBeUndefined();
    const marked = await insurer.markPlanPublished('PLAN-RACE-1', source.publishedTerms.formularyRoot, source.publishedTerms.networkRoot, source);
    expect(marked.published).toBe(false);                                     // before: true, the $99 fee labelled published
    expect(marked.publishedTerms.dispensingFeeCents).toBe(source.dispensingFeeCents);
    const stored = seq.getPlan('PLAN-RACE-1');
    expect(stored.published).toBe(false);
    expect(stored.dispensingFeeCents).toBe(9900);                             // the draft is kept, unpublished
    expect(stored.publishedTerms.dispensingFeeCents).toBe(9000);              // members are billed the published fee
  });
});

describe('F9: a plan keeps 0 and refuses amounts that are not whole cents', () => {
  const LIMITS = ['deductibleAmountCents', 'oopMaxCents', 'annualBenefitMaxCents', 'familyDeductibleAmountCents', 'familyOopMaxCents', 'familyAnnualBenefitMaxCents'];

  test('POST /plans keeps a 0 in every limit (0 means none or no limit) and publishes it as 0', async () => {
    const zeros = Object.fromEntries(LIMITS.map((k) => [k, 0]));
    const r = await call('POST', '/plans', { body: planBody('PLAN-ZERO-LIMITS', { copayAmountCents: 0, ...zeros }) });
    expect(r.status).toBe(201);
    const stored = seq.getPlan('PLAN-ZERO-LIMITS');
    for (const k of [...LIMITS, 'copayAmountCents']) {
      expect([k, stored[k], stored.publishedTerms[k]]).toEqual([k, 0, 0]);
    }
  });

  test.each(LIMITS)('POST /plans refuses a negative, fractional or string %s and stores nothing', async (field) => {
    for (const [i, bad] of [-1, 10.5, '500', null].entries()) {
      const planId = `PLAN-BAD-${field}-${i}`;
      const r = await call('POST', '/plans', { body: planBody(planId, { [field]: bad }) });
      expect([field, bad, r.status]).toEqual([field, bad, 400]);
      expect(r.payload.error).toBe(`${field} must be a whole number of cents, 0 or more`);
      expect(seq.getPlan(planId)).toBeNull();
    }
  });

  test('PUT /plans/:planId keeps a 0 and refuses a negative or fractional limit, leaving the plan as it was', async () => {
    expect((await call('POST', '/plans', { body: planBody('PLAN-PUT-LIMITS', { oopMaxCents: 400000 }) })).status).toBe(201);
    const zero = await call('PUT', '/plans/:planId', { params: { planId: 'PLAN-PUT-LIMITS' }, body: { oopMaxCents: 0, annualBenefitMaxCents: 0 } });
    expect(zero.status).toBe(200);
    expect(seq.getPlan('PLAN-PUT-LIMITS')).toMatchObject({ oopMaxCents: 0, annualBenefitMaxCents: 0 });
    for (const field of [...LIMITS, 'copayAmountCents']) {
      const r = await call('PUT', '/plans/:planId', { params: { planId: 'PLAN-PUT-LIMITS' }, body: { [field]: -100 } });
      expect([field, r.status]).toEqual([field, 400]);
      const fractional = await call('PUT', '/plans/:planId', { params: { planId: 'PLAN-PUT-LIMITS' }, body: { [field]: 99.5 } });
      expect([field, fractional.status]).toEqual([field, 400]);
    }
    expect(seq.getPlan('PLAN-PUT-LIMITS')).toMatchObject({ oopMaxCents: 0, annualBenefitMaxCents: 0, deductibleAmountCents: 100000, copayAmountCents: 1500 });
  });
});

describe('F11: plans published before the published terms were kept', () => {
  test('the insurer node names each one, one log line with its plan ID and name and nothing else', async () => {
    const base = { coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 0, oopMaxCents: 0, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, formularyNdcs: [], createdAt: 1, updatedAt: 1 };
    // A plan published before this change: published, the overlay version as its formularyRoot, no published terms.
    const legacy = { ...base, planId: 'PLAN-LEGACY', name: 'Legacy Gold', published: true, formularyRoot: '1', networkRoot: '2', networkProviderWalletIds: ['424242424242'] };
    expect((await rpc('l2_storePlan', { plan: legacy })).error).toBeUndefined();
    expect((await rpc('l2_storePlan', { plan: { ...base, planId: 'PLAN-NEVER', name: 'Never Published', published: false, networkProviderWalletIds: [] } })).error).toBeUndefined();

    const lines: string[] = [];
    const named = await insurer.reportPlansNeedingRepublish((line: string) => { lines.push(line); });
    expect(named).toEqual([{ planId: 'PLAN-LEGACY', name: 'Legacy Gold' }]);   // not the draft, not the published plans above
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PLAN-LEGACY');
    expect(lines[0]).toContain('Legacy Gold');
    expect(lines[0]).toMatch(/until the insurer publishes it again/);
    expect(lines[0]).not.toContain('424242424242');   // a provider list, like any wallet ID, stays out of the log
  });

  test('publishing it again gives it published terms, and it is named no more', async () => {
    expect((await rpc('l2_storePlan', { plan: { ...seq.getPlan('PLAN-LEGACY'), formularyNdcs: [ndcA], networkProviderWalletIds: [] } })).error).toBeUndefined();
    const r = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-LEGACY' } });
    expect(r.status).toBe(200);
    expect(seq.getPlan('PLAN-LEGACY').publishedTerms).toBeDefined();
    expect(await insurer.reportPlansNeedingRepublish(() => undefined)).toEqual([]);
  });
});
