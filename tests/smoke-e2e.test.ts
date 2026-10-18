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
 * End-to-End Smoke Test — Full Production Flow via HTTP REST
 *
 * Exercises the complete happy path through all 5 dashboards:
 *
 *   Phase 0:  Boot sequencer + 5 Nautilus app servers
 *   Phase 1:  Insurer configures + creates benefit plan + publishes formulary
 *   Phase 2:  Employer configures + selects plan + creates group + generates tokens
 *   Phase 3:  Prescriber onboards (token → key → wallet → enroll)
 *   Phase 4:  Pharmacy onboards (token → key → wallet → enroll)
 *   Phase 5:  Member onboards (token → key → wallet → enroll)
 *   Phase 6:  Compile ZK programs (real o1js)
 *   Phase 7:  Registration proofs (real ZK — 3 StateTransitionProofs)
 *   Phase 8:  Force batch settlement (Batch #1 — 3 registrations)
 *   Phase 9:  Prescriber writes e-Script to pharmacy
 *   Phase 10: Pharmacy fills prescription (claim on accumulator)
 *   Phase 11: Member views claims + NADAC pricing breakdown
 *   Phase 12: Insurer audit — chain integrity + financial balance
 *   Phase 13: Employer views roster + plan selection
 *   Phase 14: Pharmacy DUR — cross-pharmacy drug history
 *
 * Uses real seed data (NPPES prescribers/pharmacies, NADAC formulary, POC members).
 *
 * Run:
 *   npx jest tests/smoke-e2e.test.ts --verbose --testTimeout=600000
 */
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { Field, MerkleTree, Poseidon } from 'o1js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { NautilusLocalState } from '../src/nodes/nautilus-local-state.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { buildPrescriberRoutes } from '../src/nodes/routes/prescriber-routes.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';
import { buildEmployerRoutes } from '../src/nodes/routes/employer-routes.js';
import { hashString } from '../src/zkp/hash-utils.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';

// ─── Constants ──────────────────────────────────────────────

const TEST_PIN = '123456';
const TEST_ADMIN_TOKEN = 'smoke-e2e-admin';
const AUTH = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
// A6: the employer node generates enrollment codes; callers no longer choose them. These hold the
// codes P2d receives so the later onboarding steps present real ones.
let aliceCode = 'TKN-ALICE-001';
let prescriberCode = 'TKN-PRESCRIBER-001';
let pharmacyCode = 'TKN-PHARMACY-001';

const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_ROOT = emptyTree.getRoot();

// Seed data — use first prescriber, first pharmacy, first member
// (Alice Johnson from Epic Systems, Madison WI)
const PRESCRIBER_NPI = '1679576722'; // First NPPES prescriber
const PHARMACY_NPI = '1023011178';   // First NPPES pharmacy
const MEMBER = {
  cardholderId: 'EPIC-EMP-001',
  firstName: 'Alice',
  lastName: 'Johnson',
  dateOfBirth: '19850315',
};

// Lisinopril 10mg tablet — Tier 1 generic, common test drug
const TEST_NDC = '00591042101'; // Will be looked up from formulary

// ─── HTTP Helpers ───────────────────────────────────────────

interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * A5 made every member-node route but unlock require a device session. A session is issued only
 * by the unlock *route*, because the route is what verifies the PIN; unlocking the local state
 * object directly, as the setup below does, does not produce one. So the member node is unlocked
 * over HTTP as well, exactly as the member app does at startup.
 *
 * Keyed by port because a session belongs to one device and this suite runs several nodes.
 */
const deviceSessions = new Map<number, string>();

async function unlockDevice(port: number, pin: string): Promise<void> {
  const res = await post(port, '/onboarding/unlock', { pin });
  const token = (res.body as { data?: { deviceSession?: string } })?.data?.deviceSession;
  if (token) deviceSessions.set(port, token);
}

function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const session = deviceSessions.get(port);
    if (session) headers = { 'X-Device-Session': session, ...(headers ?? {}) };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function post(port: number, p: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'POST', p, body, headers);
}

async function get(port: number, p: string, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'GET', p, undefined, headers);
}

async function put(port: number, p: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'PUT', p, body, headers);
}

async function del(port: number, p: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'DELETE', p, body, headers);
}

function rpc(port: number, method: string, params?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return post(port, '/rpc', { jsonrpc: '2.0', id: 1, method, params }, headers);
}

// ─── Temp Dir ───────────────────────────────────────────────

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ─── App Factory ────────────────────────────────────────────

async function createNautilusApp(
  role: NautilusAppConfig['role'],
  sequencerUrl: string,
  displayName: string,
): Promise<{ server: NautilusAppServer; localState: NautilusLocalState; stateDir: string }> {
  const stateDir = await makeTempDir(`e2e-${role}-`);
  const config: NautilusAppConfig = {
    role,
    port: 0,
    host: '127.0.0.1',
    sequencerUrl,
    stateDir,
    enableSSE: false,
    maxSseConnections: 0,
    allowedOrigins: ['*'],
    adminToken: TEST_ADMIN_TOKEN,
    displayName,
  };

  const server = new NautilusAppServer(config);
  const localState = server.getLocalState();

  if (role !== 'insurer' && role !== 'employer') {
    await localState.unlock(TEST_PIN);
    await localState.save({
      version: 1,
      role,
      onboarding: { phase: 'awaiting_token' },
      lastSavedAt: new Date().toISOString(),
    });
  }

  return { server, localState, stateDir };
}

// ─── Test Suite ─────────────────────────────────────────────

describe('E2E Smoke — Plan → Employer → Enrollment → Prescription → Claim', () => {
  let l2Node: L2Node;
  let rpcServer: L2RpcServer;
  let rpcPort: number;
  let sequencerUrl: string;

  let insurerApp: NautilusAppServer;
  let employerApp: NautilusAppServer;
  let memberApp: NautilusAppServer;
  let prescriberApp: NautilusAppServer;
  let pharmacyApp: NautilusAppServer;

  let insurerPort: number;
  let employerPort: number;
  let memberPort: number;
  let prescriberPort: number;
  let pharmacyPort: number;

  const tempDirs: string[] = [];

  // Wallet IDs captured during onboarding
  let memberWalletId: string;
  let prescriberWalletId: string;
  let pharmacyWalletId: string;

  // NDC hash for test drug (computed after formulary loads)
  let testNdcHash: string;
  let testNdc: string;

  // ── Setup ──────────────────────────────────────────────

  beforeAll(async () => {
    // 1. Start L2Node + RPC Server
    const store = new InMemoryStore();
    l2Node = new L2Node(
      { batchIntervalMs: 600_000, autoSettle: false },
      store,
      INITIAL_ROOT,
      INITIAL_ROOT,
      Field(0),
    );
    l2Node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/smoke-e2e.test.ts'));

    rpcServer = new L2RpcServer(l2Node, { port: 0, adminToken: TEST_ADMIN_TOKEN });
    await rpcServer.start();
    rpcPort = rpcServer.getPort();
    sequencerUrl = `http://127.0.0.1:${rpcPort}`;

    // 2. Create all 5 Nautilus Apps
    const [insurer, employer, member, prescriber, pharmacy] = await Promise.all([
      createNautilusApp('insurer', sequencerUrl, 'UW Health Plan'),
      createNautilusApp('employer', sequencerUrl, 'Epic Systems'),
      createNautilusApp('member', sequencerUrl, 'Alice Johnson'),
      createNautilusApp('prescriber', sequencerUrl, 'Dr. Test Prescriber'),
      createNautilusApp('pharmacy', sequencerUrl, 'Test Pharmacy'),
    ]);

    insurerApp = insurer.server;
    employerApp = employer.server;
    memberApp = member.server;
    prescriberApp = prescriber.server;
    pharmacyApp = pharmacy.server;

    tempDirs.push(insurer.stateDir, employer.stateDir, member.stateDir, prescriber.stateDir, pharmacy.stateDir);

    // 3. Register routes
    insurerApp.registerRoutes(buildInsurerRoutes(insurerApp));
    employerApp.registerRoutes(buildEmployerRoutes(employerApp));
    memberApp.registerRoutes(buildMemberRoutes(memberApp));
    prescriberApp.registerRoutes(buildPrescriberRoutes(prescriberApp));
    pharmacyApp.registerRoutes(buildPharmacyRoutes(pharmacyApp));

    // 4. Start all HTTP servers
    await Promise.all([
      insurerApp.start(),
      employerApp.start(),
      memberApp.start(),
      prescriberApp.start(),
      pharmacyApp.start(),
    ]);

    insurerPort = insurerApp.getPort();
    employerPort = employerApp.getPort();
    memberPort = memberApp.getPort();
    await unlockDevice(memberPort, TEST_PIN);
    prescriberPort = prescriberApp.getPort();
    pharmacyPort = pharmacyApp.getPort();
  }, 60_000);

  // ── Teardown ──────────────────────────────────────────

  afterAll(async () => {
    await Promise.all([
      insurerApp?.stop(),
      employerApp?.stop(),
      memberApp?.stop(),
      prescriberApp?.stop(),
      pharmacyApp?.stop(),
    ]);
    await rpcServer?.stop();

    for (const dir of tempDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 0: Health Checks
  // ══════════════════════════════════════════════════════════

  test('P0 — all 5 servers + sequencer listening', () => {
    expect(rpcServer.isListening()).toBe(true);
    expect(insurerApp.isListening()).toBe(true);
    expect(employerApp.isListening()).toBe(true);
    expect(memberApp.isListening()).toBe(true);
    expect(prescriberApp.isListening()).toBe(true);
    expect(pharmacyApp.isListening()).toBe(true);
  });

  test('P0 — health endpoints respond with correct roles', async () => {
    const [insH, empH, memH, preH, phaH] = await Promise.all([
      get(insurerPort, '/health'),
      get(employerPort, '/health'),
      get(memberPort, '/health'),
      get(prescriberPort, '/health'),
      get(pharmacyPort, '/health'),
    ]);

    expect((insH.body as any).data.role).toBe('insurer');
    expect((empH.body as any).data.role).toBe('employer');
    expect((memH.body as any).data.role).toBe('member');
    expect((preH.body as any).data.role).toBe('prescriber');
    expect((phaH.body as any).data.role).toBe('pharmacy');
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 1: Insurer — Configure + Create Plan + Publish
  // ══════════════════════════════════════════════════════════

  test('P1a — insurer configures', async () => {
    const r = await post(insurerPort, '/onboarding/configure', {
      adminToken: TEST_ADMIN_TOKEN,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('ready');
  });

  test('P1b — store default formulary on sequencer', async () => {
    // Load formulary entries from data module and store on sequencer
    // Use a small subset (first 50 entries) for test speed
    const formularyRaw = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'src', 'data', 'formulary.json'), 'utf-8'),
    );
    const subset = formularyRaw.slice(0, 50);

    // Pick our test drug — first Tier 1 generic
    const testDrug = subset.find((f: any) => f.tierLevel === 1) ?? subset[0];
    testNdc = testDrug.ndc;
    testNdcHash = hashString(testNdc).toString();

    const r = await rpc(rpcPort, 'l2_storeFormulary', {
      planIdHash: 'default',
      formularyRoot: String(subset.length),
      entriesJson: JSON.stringify(subset),
    }, AUTH);

    expect(r.status).toBe(200);
    expect((r.body as any).result).toBeDefined();
    expect((r.body as any).error).toBeUndefined();
  });

  test('P1c — insurer creates benefit plan', async () => {
    const r = await post(insurerPort, '/plans', {
      planId: 'PLAN-GOLD-001',
      name: 'Epic Gold PPO',
      coverageType: 1,
      copayAmountCents: 1000,       // $10 copay
      deductibleAmountCents: 50000,  // $500 deductible
      oopMaxCents: 300000,           // $3,000 OOP max
      annualBenefitMaxCents: 10000000,
      familyDeductibleAmountCents: 100000,
      familyOopMaxCents: 600000,
      familyAnnualBenefitMaxCents: 20000000,
      formularyNdcs: [testNdc],
      networkProviderWalletIds: [],  // Will update after enrollment
    }, AUTH);

    expect(r.status).toBe(201);
    expect((r.body as any).ok).toBe(true);
    expect((r.body as any).data.planId).toBe('PLAN-GOLD-001');
    expect((r.body as any).data.published).toBe(false);
  });

  test('P1d — insurer publishes plan (stores formulary on sequencer)', async () => {
    const r = await post(insurerPort, '/plans/PLAN-GOLD-001/publish', undefined, AUTH);
    expect(r.status).toBe(200);
    expect((r.body as any).data.published).toBe(true);
    expect((r.body as any).data.planId).toBe('PLAN-GOLD-001');
  });

  test('P1e — plan persists on sequencer (survives restart)', async () => {
    const r = await rpc(rpcPort, 'l2_getPlan', { planId: 'PLAN-GOLD-001' });
    expect(r.status).toBe(200);
    const plan = (r.body as any).result;
    expect(plan).not.toBeNull();
    expect(plan.planId).toBe('PLAN-GOLD-001');
    expect(plan.published).toBe(true);
    expect(plan.copayAmountCents).toBe(1000);
  });

  test('P1f — insurer can list all plans', async () => {
    const r = await get(insurerPort, '/plans');
    expect(r.status).toBe(200);
    const plans = (r.body as any).data;
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans.some((p: any) => p.planId === 'PLAN-GOLD-001')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 2: Employer — Configure + Select Plan + Group + Tokens
  // ══════════════════════════════════════════════════════════

  test('P2a — employer configures', async () => {
    const r = await post(employerPort, '/onboarding/configure', {
      employerId: 'EPIC-SYSTEMS',
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('ready');
  });

  test('P2b — employer sees published plans', async () => {
    const r = await get(employerPort, '/plans/available');
    expect(r.status).toBe(200);
    const plans = (r.body as any).data;
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const gold = plans.find((p: any) => p.planId === 'PLAN-GOLD-001');
    expect(gold).toBeDefined();
    expect(gold.published).toBe(true);
    expect(gold.name).toBe('Epic Gold PPO');
  });

  test('P2c — employer creates enrollment group', async () => {
    const r = await post(employerPort, '/groups', {
      groupId: 'GRP-EPIC-2026',
      planId: 'PLAN-GOLD-001',
      effectiveDate: '20260101',
      enrollmentCap: 100,
    }, AUTH);
    expect(r.status).toBe(201);
    expect((r.body as any).data.groupId).toBe('GRP-EPIC-2026');
    expect((r.body as any).data.planId).toBe('PLAN-GOLD-001');
  });

  test('P2d — employer generates enrollment tokens', async () => {
    const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
    // Token for Alice (member)
    const r1 = await post(employerPort, '/tokens/generate', {
      groupId: 'GRP-EPIC-2026',
      employeeIdHash: 'EMP-10001',
      validUntil: '20261231',
    }, AUTH);
    expect(r1.status).toBe(201);
    aliceCode = (r1.body as any).data.tokenId;
    expect(aliceCode).toMatch(CODE);

    // Token for prescriber
    const r2 = await post(employerPort, '/tokens/generate', {
      groupId: 'GRP-EPIC-2026',
      employeeIdHash: 'PROV-RX-001',
      validUntil: '20261231',
    }, AUTH);
    expect(r2.status).toBe(201);
    prescriberCode = (r2.body as any).data.tokenId;

    // Token for pharmacy
    const r3 = await post(employerPort, '/tokens/generate', {
      groupId: 'GRP-EPIC-2026',
      employeeIdHash: 'PROV-PH-001',
      validUntil: '20261231',
    }, AUTH);
    expect(r3.status).toBe(201);
    pharmacyCode = (r3.body as any).data.tokenId;

    // A6: a caller-chosen code is refused.
    const r4 = await post(employerPort, '/tokens/generate', {
      groupId: 'GRP-EPIC-2026',
      employeeIdHash: 'EMP-10002',
      validUntil: '20261231',
      tokenId: 'TKN-CHOSEN-001',
    }, AUTH);
    expect(r4.status).toBe(400);
  });

  test('P2e — the validate oracle answers only the insurer', async () => {
    // A6: unsigned, the oracle refuses before it looks at the code.
    const r = await post(employerPort, `/tokens/${encodeURIComponent(aliceCode)}/validate`, {
      tokenPinHash: '0',
    });
    expect(r.status).toBe(401);
  });

  test('P2f — employer lists groups', async () => {
    // A7 (AUTH-13): group reads are admin now.
    expect((await get(employerPort, '/groups')).status).toBe(401);
    const r = await get(employerPort, '/groups', AUTH);
    expect(r.status).toBe(200);
    const groups = (r.body as any).data;
    expect(groups.length).toBe(1);
    expect(groups[0].groupId).toBe('GRP-EPIC-2026');
    expect(groups[0].status).toBe('active');
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 3: Prescriber Onboarding
  // ══════════════════════════════════════════════════════════

  test('P3a — prescriber accepts token', async () => {
    const r = await post(prescriberPort, '/onboarding/accept-token', {
      tokenId: prescriberCode,
      groupId: 'GRP-EPIC-2026',
      planId: 'PLAN-GOLD-001',
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('token_received');
  });

  test('P3b — prescriber generates key', async () => {
    const r = await post(prescriberPort, '/onboarding/generate-key');
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('key_generated');
  });

  test('P3c — prescriber derives wallet from NPI', async () => {
    const r = await post(prescriberPort, '/onboarding/derive-wallet', {
      prescriberIdQualifier: 1,
      prescriberId: PRESCRIBER_NPI,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('wallet_derived');
    prescriberWalletId = (r.body as any).data.walletId;
    expect(prescriberWalletId).toBeDefined();
  });

  test('P3d — prescriber enrolls (notifies insurer)', async () => {
    const r = await post(prescriberPort, '/onboarding/enroll', {
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('enrolled');
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 4: Pharmacy Onboarding
  // ══════════════════════════════════════════════════════════

  test('P4a — pharmacy accepts token', async () => {
    const r = await post(pharmacyPort, '/onboarding/accept-token', {
      tokenId: pharmacyCode,
      groupId: 'GRP-EPIC-2026',
      planId: 'PLAN-GOLD-001',
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('token_received');
  });

  test('P4b — pharmacy generates key', async () => {
    const r = await post(pharmacyPort, '/onboarding/generate-key');
    expect(r.status).toBe(200);
  });

  test('P4c — pharmacy derives wallet from NPI', async () => {
    const r = await post(pharmacyPort, '/onboarding/derive-wallet', {
      serviceProviderIdQualifier: 1,
      serviceProviderId: PHARMACY_NPI,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('wallet_derived');
    pharmacyWalletId = (r.body as any).data.walletId;
    expect(pharmacyWalletId).toBeDefined();
  });

  test('P4d — pharmacy enrolls', async () => {
    const r = await post(pharmacyPort, '/onboarding/enroll', {
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('enrolled');
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 5: Member Onboarding (Three-Party Ceremony)
  // ══════════════════════════════════════════════════════════

  test('P5a — member accepts token from employer', async () => {
    const r = await post(memberPort, '/onboarding/accept-token', {
      tokenId: aliceCode,
      groupId: 'GRP-EPIC-2026',
      planId: 'PLAN-GOLD-001',
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('token_received');
  });

  test('P5b — member generates enrollment key (on device, never transmitted)', async () => {
    const r = await post(memberPort, '/onboarding/generate-key');
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('key_generated');
    // Enrollment key is NOT in the response — it stays on device
    expect((r.body as any).data.enrollmentKey).toBeUndefined();
  });

  test('P5c — member derives wallet from PHI', async () => {
    const r = await post(memberPort, '/onboarding/derive-wallet', {
      cardholderId: MEMBER.cardholderId,
      firstName: MEMBER.firstName,
      lastName: MEMBER.lastName,
      dateOfBirth: MEMBER.dateOfBirth,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('wallet_derived');
    memberWalletId = (r.body as any).data.walletId;
    expect(memberWalletId).toBeDefined();
    // walletId is a Poseidon hash — should be a large number string
    expect(memberWalletId.length).toBeGreaterThan(10);
  });

  test('P5d — member enrolls (registers on sequencer + notifies insurer)', async () => {
    const r = await post(memberPort, '/onboarding/enroll', {
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('enrolled');
  });

  test('P5e — all three entities show enrolled phase', async () => {
    const [memS, preS, phaS] = await Promise.all([
      get(memberPort, '/onboarding/status'),
      get(prescriberPort, '/onboarding/status'),
      get(pharmacyPort, '/onboarding/status'),
    ]);
    expect((memS.body as any).data.phase).toBe('enrolled');
    expect((preS.body as any).data.phase).toBe('enrolled');
    expect((phaS.body as any).data.phase).toBe('enrolled');
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 6: Compile ZK Programs (real o1js — slow)
  // ══════════════════════════════════════════════════════════

  test('P6a — member compiles ZK programs', async () => {
    const r = await post(memberPort, '/onboarding/compile');
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('ready');
  }, 300_000);

  test('P6b — prescriber compiles ZK programs', async () => {
    const r = await post(prescriberPort, '/onboarding/compile');
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('ready');
  }, 300_000);

  test('P6c — pharmacy compiles ZK programs', async () => {
    const r = await post(pharmacyPort, '/onboarding/compile');
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('ready');
  }, 300_000);

  // ══════════════════════════════════════════════════════════
  //  PHASE 7: Registration Proofs (real ZK proving)
  // ══════════════════════════════════════════════════════════

  test('P7a — member generates registration proof', async () => {
    const r = await post(memberPort, '/proof/registration');
    if (r.status !== 200) console.error('P7a error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).data.proofGenerated).toBe(true);
    expect((r.body as any).data.submittedToSequencer).toBe(true);
    expect((r.body as any).data.receiptId).toBeDefined();
  }, 300_000);

  test('P7b — prescriber generates registration proof', async () => {
    const r = await post(prescriberPort, '/proof/registration');
    if (r.status !== 200) console.error('P7b error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).data.proofGenerated).toBe(true);
    expect((r.body as any).data.receiptId).toBeDefined();
  }, 300_000);

  test('P7c — pharmacy generates registration proof', async () => {
    const r = await post(pharmacyPort, '/proof/registration');
    if (r.status !== 200) console.error('P7c error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).data.proofGenerated).toBe(true);
    expect((r.body as any).data.receiptId).toBeDefined();
  }, 300_000);

  test('P7d — sequencer shows 3 registered wallets', async () => {
    const r = await rpc(rpcPort, 'l2_getStatus');
    expect(r.status).toBe(200);
    const result = (r.body as any).result;
    expect(result.currentWalletCount).toBe('3');
    expect(result.totalProofsAccepted).toBe(3);
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 8: Force Batch Settlement
  // ══════════════════════════════════════════════════════════

  test('P8a — insurer forces batch settlement', async () => {
    const r = await post(insurerPort, '/admin/batch/force', undefined, AUTH);
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
  }, 300_000);

  test('P8b — sequencer accepted 3 proofs (batch proving requires compiled BatchProgram)', async () => {
    // Note: forceBatch returns null when BatchProgram is not compiled on the
    // sequencer side (expected — the smoke test only compiles StateTransitionProgram
    // on the client side for proof generation). Verify state via sequencer status.
    const r = await rpc(rpcPort, 'l2_getStatus');
    expect(r.status).toBe(200);
    const result = (r.body as any).result;
    expect(result.totalProofsAccepted).toBe(3);
  });

  test('P8c — insurer sees all 3 receipts', async () => {
    const r = await get(insurerPort, '/receipts/all');
    expect(r.status).toBe(200);
    const receipts = (r.body as any).data;
    expect(receipts.length).toBe(3);
    for (const receipt of receipts) {
      expect(receipt.isRegistration).toBe(true);
    }
  });

  test('P8d — audit chain has 3 events and is valid', async () => {
    const [logR, intR] = await Promise.all([
      get(insurerPort, '/audit/log'),
      get(insurerPort, '/audit/chain-integrity'),
    ]);
    expect(logR.status).toBe(200);
    expect((logR.body as any).data.events).toHaveLength(3);
    expect(intR.status).toBe(200);
    expect((intR.body as any).data.isValid).toBe(true);
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 9: Prescriber Writes e-Script
  // ══════════════════════════════════════════════════════════

  test('P9a — prescriber writes prescription to pharmacy', async () => {
    const r = await post(prescriberPort, '/prescriptions/write', {
      memberWalletId,
      pharmacyWalletId,
      ndcHash: testNdcHash,
      brandName: 'Lisinopril 10mg',
      quantity: 30,
      daysSupply: 30,
      refills: 3,
      directions: 'Take one tablet daily',
      diagnosis: 'Hypertension',
    });
    if (r.status !== 200) console.error('P9a error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
    expect((r.body as any).data.rxId).toBeDefined();
  });

  test('P9b — pharmacy sees prescription in inbox', async () => {
    const r = await get(pharmacyPort, '/messaging/inbox');
    expect(r.status).toBe(200);
    const messages = (r.body as any).data;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // MessageStoreEntry has nested .message with StoredMessage fields
    const escript = messages.find((m: any) => m.message?.messageType === '3');
    expect(escript).toBeDefined();
    expect(escript.message.senderWalletId).toBe(prescriberWalletId);
  });

  test('P9c — member sees prescription notification', async () => {
    const r = await get(memberPort, '/messaging/inbox');
    expect(r.status).toBe(200);
    const messages = (r.body as any).data;
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test('P9d — prescriber sees sent prescriptions', async () => {
    const r = await get(prescriberPort, '/messaging/sent');
    expect(r.status).toBe(200);
    const sent = (r.body as any).data;
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // Verify the sent eScript message
    const escript = sent.find((m: any) => m.message?.messageType === '3');
    expect(escript).toBeDefined();
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 10: Pharmacy Fills Prescription (Claim on Accumulator)
  // ══════════════════════════════════════════════════════════

  test('P10a — pharmacy fills prescription', async () => {
    const r = await post(pharmacyPort, '/dispensing/fill', {
      memberWalletId,
      ndcHash: testNdcHash,
      prescriberWalletId,
      brandName: 'Lisinopril 10mg',
      ndc: testNdc,
      quantity: 30,
      daysSupply: 30,
      fillNumber: 0,
      patientPayCents: '1000',   // $10 copay
      planPayCents: '3250',      // Plan pays $32.50
      ingredientCostCents: 2950, // NADAC $29.50
      dispensingFeeCents: 1300,  // $13.00 dispensing fee
      quantityDispensed: 30,
    });
    if (r.status !== 200) console.error('P10a error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
  });

  test('P10b — claim appears in accumulator', async () => {
    const r = await rpc(rpcPort, 'l2_getClaimsByMember', { walletId: memberWalletId }, AUTH);
    expect(r.status).toBe(200);
    expect((r.body as any).error).toBeUndefined();
    const claims = (r.body as any).result;
    expect(claims.length).toBe(1);
    expect(claims[0].leaf.memberWalletId).toBe(memberWalletId);
    expect(claims[0].leaf.ndcHash).toBe(testNdcHash);
    expect(claims[0].leaf.pharmacyWalletId).toBe(pharmacyWalletId);
    expect(claims[0].leaf.prescriberWalletId).toBe(prescriberWalletId);
    expect(claims[0].leaf.patientPayCents).toBe('1000');
    expect(claims[0].leaf.planPayCents).toBe('3250');
    expect(claims[0].leaf.operationType).toBe('1'); // fulfillment
  });

  test('P10c — claim has NADAC pricing metadata', async () => {
    const r = await rpc(rpcPort, 'l2_getClaimsByMember', { walletId: memberWalletId }, AUTH);
    const claim = (r.body as any).result[0];
    expect(claim.metadata.ingredientCostCents).toBe(2950);
    expect(claim.metadata.dispensingFeeCents).toBe(1300);
    expect(claim.metadata.totalDrugCostCents).toBe(4250); // 2950 + 1300
    expect(claim.metadata.quantityDispensed).toBe(30);
    expect(claim.metadata.brandName).toBe('Lisinopril 10mg');
    expect(claim.metadata.ndc).toBe(testNdc);
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 11: Member Views Claims + NADAC Breakdown
  // ══════════════════════════════════════════════════════════

  test('P11a — member sees drug history', async () => {
    const r = await get(memberPort, '/drugs');
    expect(r.status).toBe(200);
    const claims = (r.body as any).data;
    expect(claims.length).toBe(1);
    // EntityClaimView is flat — no .leaf nesting
    expect(claims[0].patientPayCents).toBe('1000');
  });

  test('P11b — member can get claim with Merkle proof', async () => {
    // Get the leaf index from claims
    const claimsR = await rpc(rpcPort, 'l2_getClaimsByMember', { walletId: memberWalletId }, AUTH);
    const leafIndex = (claimsR.body as any).result[0].leafIndex;

    const r = await rpc(rpcPort, 'l2_getClaimWithProof', { leafIndex: String(leafIndex) }, AUTH);
    expect(r.status).toBe(200);
    const result = (r.body as any).result;
    expect(result.entry).toBeDefined();
    expect(result.witnessJson).toBeDefined();
    expect(result.root).toBeDefined();
  });

  test('P11c — member can query formulary', async () => {
    const r = await get(memberPort, '/formulary/default');
    expect(r.status).toBe(200);
    const formulary = (r.body as any).data;
    expect(formulary.entriesJson).toBeDefined();
    // entriesJson is a JSON string — parse to verify entries exist
    const entries = JSON.parse(formulary.entriesJson);
    expect(entries.length).toBeGreaterThan(0);
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 12: Insurer Audit — Chain Integrity + Financial Balance
  // ══════════════════════════════════════════════════════════

  test('P12a — insurer sees member claims', async () => {
    const r = await get(insurerPort, `/claims/member/${memberWalletId}`);
    expect(r.status).toBe(200);
    const claims = (r.body as any).data;
    expect(claims.length).toBe(1);
    // EntityClaimView is flat
    expect(claims[0].patientPayCents).toBe('1000');
    expect(claims[0].planPayCents).toBe('3250');
  });

  test('P12b — insurer sees pharmacy claims', async () => {
    const r = await get(insurerPort, `/claims/pharmacy/${pharmacyWalletId}`);
    expect(r.status).toBe(200);
    expect((r.body as any).data.length).toBe(1);
  });

  test('P12c — insurer sees prescriber claims', async () => {
    const r = await get(insurerPort, `/claims/prescriber/${prescriberWalletId}`);
    expect(r.status).toBe(200);
    expect((r.body as any).data.length).toBe(1);
  });

  test('P12d — insurer sees drug-level claims', async () => {
    const r = await get(insurerPort, `/claims/drug/${testNdcHash}`);
    expect(r.status).toBe(200);
    expect((r.body as any).data.length).toBe(1);
  });

  test('P12e — audit chain integrity still valid', async () => {
    const r = await get(insurerPort, '/audit/chain-integrity');
    expect(r.status).toBe(200);
    expect((r.body as any).data.isValid).toBe(true);
  });

  test('P12f — financial balance check', async () => {
    const r = await get(insurerPort, '/audit/financial-balance');
    expect(r.status).toBe(200);
    expect((r.body as any).data).toBeDefined();
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 13: Employer Views Roster + Sequencer State
  // ══════════════════════════════════════════════════════════

  test('P13a — employer views groups', async () => {
    const r = await get(employerPort, '/groups/GRP-EPIC-2026', AUTH);
    expect(r.status).toBe(200);
    const group = (r.body as any).data;
    expect(group.groupId).toBe('GRP-EPIC-2026');
    expect(group.planId).toBe('PLAN-GOLD-001');
    expect(group.status).toBe('active');
  });

  test('P13b — employer can query sequencer chain state', async () => {
    const r = await get(employerPort, '/sequencer/chain-state');
    expect(r.status).toBe(200);
    expect((r.body as any).data).toBeDefined();
  });

  test('P13c — employer can query sequencer status', async () => {
    const r = await get(employerPort, '/sequencer/status');
    expect(r.status).toBe(200);
    const status = (r.body as any).data;
    expect(status.currentWalletCount).toBeDefined();
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 14: Pharmacy DUR — Cross-Pharmacy Drug History
  // ══════════════════════════════════════════════════════════

  test('P14a — pharmacy queries full patient drug history (DUR)', async () => {
    const r = await get(pharmacyPort, `/dur/patient/${memberWalletId}/full-history`);
    expect(r.status).toBe(200);
    const history = (r.body as any).data;
    expect(history.length).toBe(1);
    // EntityClaimView is flat
    expect(history[0].ndcHash).toBe(testNdcHash);
  });

  test('P14b — pharmacy queries active medications', async () => {
    const r = await get(pharmacyPort, `/dur/patient/${memberWalletId}/active-medications`);
    expect(r.status).toBe(200);
    const active = (r.body as any).data;
    expect(active.length).toBe(1);
  });

  test('P14c — pharmacy checks for duplicate therapy', async () => {
    const r = await get(pharmacyPort, `/dur/patient/${memberWalletId}/check/${testNdcHash}`);
    expect(r.status).toBe(200);
    const check = (r.body as any).data;
    // Patient already has this drug — should flag duplicate
    expect(check.activeClaim).toBeDefined();
  });

  test('P14d — pharmacy dispensing summary', async () => {
    const r = await get(pharmacyPort, '/dispensing/summary');
    expect(r.status).toBe(200);
    const summary = (r.body as any).data;
    expect(summary.totalClaims).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════════
  //  PHASE 15: Cross-Cutting Verification
  // ══════════════════════════════════════════════════════════

  test('P15a — claim accumulator root is non-zero', async () => {
    const r = await rpc(rpcPort, 'l2_getClaimAccumulatorRoot');
    expect(r.status).toBe(200);
    const root = (r.body as any).result;
    expect(root).toBeDefined();
    expect(root).not.toBe('0');
  });

  test('P15b — sequencer wallet count reflects ZK registrations', async () => {
    // After P7 (real ZK proofs): 3 registered wallets
    // Without P7: 0 wallets (entity registered but no proof submitted)
    const r = await rpc(rpcPort, 'l2_getStatus');
    expect(r.status).toBe(200);
    const count = (r.body as any).result.currentWalletCount;
    // Either 0 (no proofs) or 3 (all proofs)
    expect(['0', '3']).toContain(count);
  });

  test('P15c — registration witnesses are consistent', async () => {
    const r = await rpc(rpcPort, 'l2_getRegistrationWitnesses');
    expect(r.status).toBe(200);
    const slot = (r.body as any).result.nextSlotIndex;
    // Either 0 (no proofs) or 3 (all proofs)
    expect(['0', '3']).toContain(slot);
  });

  test('P15d — proof timings available after ZK phases', async () => {
    const [memT, preT, phaT] = await Promise.all([
      get(memberPort, '/proof-timings'),
      get(prescriberPort, '/proof-timings'),
      get(pharmacyPort, '/proof-timings'),
    ]);
    // Timings only exist after compile+prove phases (P6-P7)
    expect((memT.body as any).data).toBeInstanceOf(Array);
    expect((preT.body as any).data).toBeInstanceOf(Array);
    expect((phaT.body as any).data).toBeInstanceOf(Array);
  });
});
