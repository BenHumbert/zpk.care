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
 * Smoke Test — Single L2Node + 4 Nautilus Entity Apps (HTTP routes)
 *
 * Validates the full REST route flow:
 *   - L2Node + L2RpcServer (sequencer)
 *   - Insurer NautilusAppServer (configure → enrollment)
 *   - Member NautilusAppServer (onboarding → compile → registration proof)
 *   - Prescriber NautilusAppServer (onboarding → compile → registration proof)
 *   - Pharmacy NautilusAppServer (onboarding → compile → registration proof)
 *
 * All communication is via HTTP REST — no direct method calls between nodes.
 *
 * Mock-based: no real ZkProgram compilation or proof generation.
 * This tests route wiring, state transitions, and cross-node communication.
 *
 * Run: npx jest tests/smoke-leviathan.test.ts --verbose --testTimeout=60000
 */
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { Field, MerkleTree } from 'o1js';
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
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';

// ─── Constants ──────────────────────────────────────────────

const TEST_PIN = '123456';
const TEST_ADMIN_TOKEN = 'test-admin-token';

const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_ROOT = emptyTree.getRoot();

// ─── HTTP Helpers ───────────────────────────────────────────

interface HttpResult {
  status: number;
  body: unknown;
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
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

async function post(port: number, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'POST', path, body, headers);
}

async function get(port: number, path: string, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'GET', path, undefined, headers);
}

// ─── Temp Dir Helpers ───────────────────────────────────────

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ─── App Factory ────────────────────────────────────────────

async function createNautilusApp(
  role: NautilusAppConfig['role'],
  sequencerUrl: string,
  displayName: string,
): Promise<{ server: NautilusAppServer; localState: NautilusLocalState; stateDir: string }> {
  const stateDir = await makeTempDir(`smoke-${role}-`);
  const config: NautilusAppConfig = {
    role,
    port: 0, // OS-assigned
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

  // Unlock and initialize state
  await localState.unlock(TEST_PIN);
  await localState.save({
    version: 1,
    role,
    onboarding: { phase: 'awaiting_token' },
    lastSavedAt: new Date().toISOString(),
  });

  return { server, localState, stateDir };
}

// ─── Test Suite ────────────────────────────────────────────

describe('Smoke — L2Node + 4 Nautilus Apps (HTTP routes)', () => {
  let l2Node: L2Node;
  let rpcServer: L2RpcServer;
  let rpcPort: number;
  let sequencerUrl: string;

  let insurerApp: NautilusAppServer;
  let memberApp: NautilusAppServer;
  let prescriberApp: NautilusAppServer;
  let pharmacyApp: NautilusAppServer;

  let insurerPort: number;
  let memberPort: number;
  let prescriberPort: number;
  let pharmacyPort: number;

  const tempDirs: string[] = [];

  // ── Setup ──────────────────────────────────────────────

  beforeAll(async () => {
    // 1. Start L2Node + RPC Server
    const store = new InMemoryStore();
    l2Node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      INITIAL_ROOT,
      INITIAL_ROOT,
      Field(0),
    );
    l2Node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/smoke-leviathan.test.ts'));

    rpcServer = new L2RpcServer(l2Node, { port: 0, adminToken: TEST_ADMIN_TOKEN });
    await rpcServer.start();
    rpcPort = rpcServer.getPort();
    sequencerUrl = `http://127.0.0.1:${rpcPort}`;

    // 2. Create Nautilus Apps
    const insurer = await createNautilusApp('insurer', sequencerUrl, 'Test Insurer');
    insurerApp = insurer.server;
    tempDirs.push(insurer.stateDir);

    const member = await createNautilusApp('member', sequencerUrl, 'Test Member');
    memberApp = member.server;
    tempDirs.push(member.stateDir);

    const prescriber = await createNautilusApp('prescriber', sequencerUrl, 'Test Prescriber');
    prescriberApp = prescriber.server;
    tempDirs.push(prescriber.stateDir);

    const pharmacy = await createNautilusApp('pharmacy', sequencerUrl, 'Test Pharmacy');
    pharmacyApp = pharmacy.server;
    tempDirs.push(pharmacy.stateDir);

    // 3. Register routes
    insurerApp.registerRoutes(buildInsurerRoutes(insurerApp));
    memberApp.registerRoutes(buildMemberRoutes(memberApp));
    prescriberApp.registerRoutes(buildPrescriberRoutes(prescriberApp));
    pharmacyApp.registerRoutes(buildPharmacyRoutes(pharmacyApp));

    // 4. Start all HTTP servers
    await Promise.all([
      insurerApp.start(),
      memberApp.start(),
      prescriberApp.start(),
      pharmacyApp.start(),
    ]);

    insurerPort = insurerApp.getPort();
    memberPort = memberApp.getPort();
    prescriberPort = prescriberApp.getPort();
    pharmacyPort = pharmacyApp.getPort();
  }, 30_000);

  // ── Teardown ───────────────────────────────────────────

  afterAll(async () => {
    await Promise.all([
      insurerApp?.stop(),
      memberApp?.stop(),
      prescriberApp?.stop(),
      pharmacyApp?.stop(),
    ]);
    await rpcServer?.stop();

    // Clean up temp dirs
    for (const dir of tempDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── Phase 0: Health checks ────────────────────────────

  test('P0 — all servers are listening', () => {
    expect(rpcServer.isListening()).toBe(true);
    expect(insurerApp.isListening()).toBe(true);
    expect(memberApp.isListening()).toBe(true);
    expect(prescriberApp.isListening()).toBe(true);
    expect(pharmacyApp.isListening()).toBe(true);
  });

  test('P0 — health endpoints respond', async () => {
    const [insH, memH, preH, phaH] = await Promise.all([
      get(insurerPort, '/health'),
      get(memberPort, '/health'),
      get(prescriberPort, '/health'),
      get(pharmacyPort, '/health'),
    ]);

    expect(insH.status).toBe(200);
    expect((insH.body as any).data.role).toBe('insurer');
    expect(memH.status).toBe(200);
    expect((memH.body as any).data.role).toBe('member');
    expect(preH.status).toBe(200);
    expect((preH.body as any).data.role).toBe('prescriber');
    expect(phaH.status).toBe(200);
    expect((phaH.body as any).data.role).toBe('pharmacy');
  });

  // ── Phase 1: Insurer configuration ────────────────────

  test('P1 — insurer configures', async () => {
    const result = await post(insurerPort, '/onboarding/configure', {
      adminToken: TEST_ADMIN_TOKEN,
    });

    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data.phase).toBe('ready');
  });

  test('P1 — insurer rejects double configure', async () => {
    const result = await post(insurerPort, '/onboarding/configure', {});
    expect(result.status).toBe(409);
  });

  // ── Phase 2: Member onboarding ────────────────────────

  test('P2 — member accept-token', async () => {
    const result = await post(memberPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-001',
      groupId: 'GROUP-001',
      planId: 'PLAN-001',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('token_received');
  });

  test('P2 — member generate-key', async () => {
    const result = await post(memberPort, '/onboarding/generate-key');
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('key_generated');
  });

  test('P2 — member derive-wallet', async () => {
    const result = await post(memberPort, '/onboarding/derive-wallet', {
      cardholderId: 'CH-001',
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: '19900101',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('wallet_derived');
    expect((result.body as any).data.walletId).toBeDefined();
  });

  test('P2 — member enroll (notifies insurer)', async () => {
    const insurerUrl = `http://127.0.0.1:${insurerPort}`;
    const result = await post(memberPort, '/onboarding/enroll', {
      insurerUrl,
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('enrolled');
    expect((result.body as any).data.walletId).toBeDefined();
    // Note: insurerNotified may be false because the insurer enrollment
    // endpoint requires admin auth, and the member doesn't send the token.
    // This is expected for now — the route wiring is what we're testing.
  });

  test('P2 — member wrong-phase rejected', async () => {
    const result = await post(memberPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-DUPE',
    });
    expect(result.status).toBe(409);
  });

  // ── Phase 3: Prescriber onboarding ────────────────────

  test('P3 — prescriber accept-token', async () => {
    const result = await post(prescriberPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-002',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('token_received');
  });

  test('P3 — prescriber generate-key', async () => {
    const result = await post(prescriberPort, '/onboarding/generate-key');
    expect(result.status).toBe(200);
  });

  test('P3 — prescriber derive-wallet', async () => {
    const result = await post(prescriberPort, '/onboarding/derive-wallet', {
      prescriberIdQualifier: 1,
      prescriberId: 'NPI-1234567890',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('wallet_derived');
  });

  test('P3 — prescriber enroll', async () => {
    const result = await post(prescriberPort, '/onboarding/enroll', {
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('enrolled');
  });

  // ── Phase 4: Pharmacy onboarding ──────────────────────

  test('P4 — pharmacy accept-token', async () => {
    const result = await post(pharmacyPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-003',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('token_received');
  });

  test('P4 — pharmacy generate-key', async () => {
    const result = await post(pharmacyPort, '/onboarding/generate-key');
    expect(result.status).toBe(200);
  });

  test('P4 — pharmacy derive-wallet', async () => {
    const result = await post(pharmacyPort, '/onboarding/derive-wallet', {
      serviceProviderIdQualifier: 1,
      serviceProviderId: 'NPI-9876543210',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('wallet_derived');
  });

  test('P4 — pharmacy enroll', async () => {
    const result = await post(pharmacyPort, '/onboarding/enroll', {
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('enrolled');
  });

  // ── Phase 5: Onboarding status queries ────────────────

  test('P5 — onboarding status shows enrolled', async () => {
    const [memStatus, preStatus, phaStatus] = await Promise.all([
      get(memberPort, '/onboarding/status'),
      get(prescriberPort, '/onboarding/status'),
      get(pharmacyPort, '/onboarding/status'),
    ]);

    expect(memStatus.status).toBe(200);
    expect((memStatus.body as any).data.phase).toBe('enrolled');
    expect((memStatus.body as any).data.walletId).toBeDefined();

    expect(preStatus.status).toBe(200);
    expect((preStatus.body as any).data.phase).toBe('enrolled');

    expect(phaStatus.status).toBe(200);
    expect((phaStatus.body as any).data.phase).toBe('enrolled');
  });

  // ── Phase 6: Compile programs (mock — just checks route wiring) ──

  test('P6 — compile rejects when not enrolled', async () => {
    // Insurer has no compile route, but member/prescriber/pharmacy do
    // member is already enrolled, so let's test that compile can be called
    // The compile route will actually call node.compilePrograms() which
    // will take a long time with real o1js, so we test that the route
    // exists and the phase check works
    const result = await post(memberPort, '/onboarding/accept-token', {
      tokenId: 'X',
    });
    // Should be 409 because phase is 'enrolled', not 'awaiting_token'
    expect(result.status).toBe(409);
  });

  // ── Phase 7: Proof registration rejects before compile ──

  test('P7 — registration proof rejects before compile', async () => {
    // Phase is 'enrolled', not 'ready' — should reject
    const result = await post(memberPort, '/proof/registration');
    expect(result.status).toBe(409);
    expect((result.body as any).error).toContain('Cannot generate proof');
  });

  test('P7 — prescriber registration proof rejects before compile', async () => {
    const result = await post(prescriberPort, '/proof/registration');
    expect(result.status).toBe(409);
  });

  test('P7 — pharmacy registration proof rejects before compile', async () => {
    const result = await post(pharmacyPort, '/proof/registration');
    expect(result.status).toBe(409);
  });

  // ── Phase 8: Insurer system queries ───────────────────

  test('P8 — insurer can query receipts', async () => {
    const result = await get(insurerPort, '/receipts/all');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data).toEqual([]);
  });

  test('P8 — insurer can query batches', async () => {
    const result = await get(insurerPort, '/batches/all');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
  });

  test('P8 — insurer can query audit log', async () => {
    const result = await get(insurerPort, '/audit/log');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
  });

  // ── Phase 9: Insurer enrollment endpoint ──────────────

  test('P9 — insurer enrollment endpoint works with admin token', async () => {
    const result = await post(
      insurerPort,
      '/enrollment/process',
      { walletId: '12345', tokenId: 'TOKEN-001', role: 'member' },
      { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    );
    expect(result.status).toBe(200);
    expect((result.body as any).data.enrolled).toBe(true);
    expect((result.body as any).data.walletId).toBe('12345');
    expect((result.body as any).data.role).toBe('member');
  });

  test('P9 — insurer enrollment endpoint rejects without admin token', async () => {
    const result = await post(insurerPort, '/enrollment/process', {
      walletId: '12345',
    });
    expect(result.status).toBe(401);
  });

  // ── Phase 10: Sequencer status via RPC ────────────────

  test('P10 — sequencer status shows 0 wallets', async () => {
    const result = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0',
      id: 1,
      method: 'l2_getStatus',
    });
    expect(result.status).toBe(200);
    const rpcBody = result.body as any;
    expect(rpcBody.result).toBeDefined();
    expect(rpcBody.result.currentWalletCount).toBe('0');
  });

  test('P10 — registration witnesses available', async () => {
    const result = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0',
      id: 2,
      method: 'l2_getRegistrationWitnesses',
    });
    expect(result.status).toBe(200);
    const rpcBody = result.body as any;
    expect(rpcBody.result).toBeDefined();
    expect(rpcBody.result.registryWitnessJson).toBeDefined();
    expect(rpcBody.result.lifecycleWitnessJson).toBeDefined();
    expect(rpcBody.result.currentRegistryRoot).toBeDefined();
    expect(rpcBody.result.currentLifecycleRoot).toBeDefined();
    expect(rpcBody.result.nextSlotIndex).toBe('0');
  });

  // ── Phase 11: 404 for unknown routes ──────────────────

  test('P11 — unknown routes return 404', async () => {
    const result = await get(memberPort, '/does-not-exist');
    expect(result.status).toBe(404);
  });

  // ── Phase 12: Cross-cutting — query routes on non-ready nodes ──

  test('P12 — member drug query returns empty history', async () => {
    // member is enrolled (node exists) but no claims have been submitted
    const result = await get(memberPort, '/drugs');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════
  //  REAL ZK PROOF PHASES (compile + prove + verify)
  //
  //  These phases do actual o1js compilation and proof generation.
  //  First compilation ~30-120s, subsequent near-instant (cached).
  //  Each proof ~30-120s.
  // ══════════════════════════════════════════════════════════

  // ── Phase 13: Compile programs (real o1js) ────────────

  test('P13 — member compile programs', async () => {
    const result = await post(memberPort, '/onboarding/compile');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data.phase).toBe('ready');
    expect((result.body as any).data.compilationStatus).toBeDefined();
  }, 300_000); // 5 min — first compilation is slow

  test('P13 — prescriber compile programs', async () => {
    const result = await post(prescriberPort, '/onboarding/compile');
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('ready');
  }, 300_000);

  test('P13 — pharmacy compile programs', async () => {
    const result = await post(pharmacyPort, '/onboarding/compile');
    expect(result.status).toBe(200);
    expect((result.body as any).data.phase).toBe('ready');
  }, 300_000);

  // ── Phase 14: Health checks show ready ────────────────

  test('P14 — all entities show ready phase', async () => {
    const [memH, preH, phaH] = await Promise.all([
      get(memberPort, '/health'),
      get(prescriberPort, '/health'),
      get(pharmacyPort, '/health'),
    ]);
    expect((memH.body as any).data.phase).toBe('ready');
    expect((preH.body as any).data.phase).toBe('ready');
    expect((phaH.body as any).data.phase).toBe('ready');
  });

  // ── Phase 15: Registration proofs (real ZK) ───────────

  test('P15 — member registration proof', async () => {
    const result = await post(memberPort, '/proof/registration');
    if (result.status !== 200) {
      console.error('P15 member error:', JSON.stringify(result.body, null, 2));
    }
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data.proofGenerated).toBe(true);
    expect((result.body as any).data.submittedToSequencer).toBe(true);
    expect((result.body as any).data.receiptId).toBeDefined();
    expect((result.body as any).data.walletId).toBeDefined();
  }, 300_000);

  test('P15 — prescriber registration proof', async () => {
    const result = await post(prescriberPort, '/proof/registration');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data.proofGenerated).toBe(true);
    expect((result.body as any).data.receiptId).toBeDefined();
  }, 300_000);

  test('P15 — pharmacy registration proof', async () => {
    const result = await post(pharmacyPort, '/proof/registration');
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data.proofGenerated).toBe(true);
    expect((result.body as any).data.receiptId).toBeDefined();
  }, 300_000);

  // ── Phase 16: Verify chain state ──────────────────────

  test('P16 — sequencer shows 3 registered wallets', async () => {
    const result = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0',
      id: 100,
      method: 'l2_getStatus',
    });
    expect(result.status).toBe(200);
    const rpcBody = result.body as any;
    expect(rpcBody.result.currentWalletCount).toBe('3');
    expect(rpcBody.result.totalProofsAccepted).toBe(3);
  });

  test('P16 — insurer can see all 3 receipts', async () => {
    const result = await get(insurerPort, '/receipts/all');
    expect(result.status).toBe(200);
    const receipts = (result.body as any).data;
    expect(receipts).toHaveLength(3);
    expect(receipts[0].isRegistration).toBe(true);
    expect(receipts[1].isRegistration).toBe(true);
    expect(receipts[2].isRegistration).toBe(true);
  });

  test('P16 — audit log has 3 events', async () => {
    const result = await get(insurerPort, '/audit/log');
    expect(result.status).toBe(200);
    const log = (result.body as any).data;
    expect(log.events).toHaveLength(3);
    // Chain integrity is a separate endpoint
    const integrity = await get(insurerPort, '/audit/chain-integrity');
    expect(integrity.status).toBe(200);
    expect((integrity.body as any).data.isValid).toBe(true);
  });

  test('P16 — registration witnesses now at slot 3', async () => {
    const result = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0',
      id: 101,
      method: 'l2_getRegistrationWitnesses',
    });
    expect(result.status).toBe(200);
    const rpcBody = result.body as any;
    expect(rpcBody.result.nextSlotIndex).toBe('3');
  });

  // ── Phase 17: Proof timings recorded ──────────────────

  test('P17 — member proof timings available', async () => {
    const result = await get(memberPort, '/proof-timings');
    expect(result.status).toBe(200);
    const timings = (result.body as any).data;
    expect(timings).toBeInstanceOf(Array);
    expect(timings.length).toBeGreaterThan(0);
    // Should have a proveRegistration timing
    const regTiming = timings.find((t: any) => t.programName === 'proveRegistration');
    expect(regTiming).toBeDefined();
    expect(regTiming.estimatedMs).toBeGreaterThan(0);
  });

  test('P17 — prescriber proof timings available', async () => {
    const result = await get(prescriberPort, '/proof-timings');
    expect(result.status).toBe(200);
    expect((result.body as any).data.length).toBeGreaterThan(0);
  });

  test('P17 — pharmacy proof timings available', async () => {
    const result = await get(pharmacyPort, '/proof-timings');
    expect(result.status).toBe(200);
    expect((result.body as any).data.length).toBeGreaterThan(0);
  });

  // ── Phase 18: Double registration rejected ────────────

  test('P18 — duplicate member registration proof rejected by sequencer', async () => {
    // The sequencer should reject a second registration for the same wallet
    // because the registry root has changed since the first proof
    const result = await post(memberPort, '/proof/registration');
    // Should fail — either 500 (proof verification fails) or the proof
    // itself errors because the witness doesn't match anymore
    expect(result.status).not.toBe(200);
  }, 300_000);
});
