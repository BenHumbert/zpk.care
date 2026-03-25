/**
 * Production Showcase — Full Lifecycle Test
 *
 * The story of Alice Johnson's healthcare journey:
 *   1. Alice, Dr. Chen, and Main St Pharmacy all enroll and register (real ZK proofs)
 *   2. Alice picks Dr. Chen as her PCP
 *   3. Alice messages Dr. Chen: "I have a massive mole on the side of my arm"
 *   4. Dr. Chen replies: "It's not moles, it's cancer!"
 *   5. Alice replies: "OK prescribe me amoxicillin then"
 *   6. Dr. Chen prescribes Amoxicillin 500mg — pharmacy fills it
 *   7. ZK claim adjudication: $3.60 patient pays (in deductible), $0 plan pays
 *   8. L2 batch settlement, audit verification, insurer reporting
 *
 * Run:
 *   npx jest tests/production-showcase.test.ts --verbose --testTimeout=600000
 */
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { Field, Poseidon, Encoding, MerkleTree } from 'o1js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT, WalletRegistryWitness } from '../src/wallets/wallet-state.js';
import { LifecycleWitness } from '../src/engine/lifecycle.js';
import { EMPTY_CREDENTIAL_ROOT, StateTransitionProgram } from '../src/engine/state-transition.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { NautilusLocalState } from '../src/nodes/nautilus-local-state.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { buildPrescriberRoutes } from '../src/nodes/routes/prescriber-routes.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';

// Claim cycle imports
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  pharmacyWalletPreimage,
} from '../src/wallets/wallet-derivation.js';
import { AccumulatorFulfillmentProgram } from '../src/fulfillment/accumulator-fulfillment-program.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY, CREDENTIAL_TYPE_PRESCRIPTION } from '../src/credentials/credential-data.js';
import { EligibilityData } from '../src/eligibility/eligibility-data.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { PrescriptionData, PrescriptionStatusData, RX_STATUS_ADJUDICATED, RX_STATUS_FILLED } from '../src/prescription/prescription-data.js';
import { FulfillmentData } from '../src/fulfillment/fulfillment-data.js';
import { FormularyEntry, buildFormularyEntry } from '../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import { AccumulatorData, ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';
import { hashString, dateToField, centsToField, quantityToField, codeToField } from '../src/zkp/hash-utils.js';
import { PlanTemplate } from '../src/onboarding/plan-template.js';
import { MEMBERS, PRESCRIBERS, PHARMACIES, MEDICATIONS, getAllFormularyEntries } from '../src/data/index.js';

// ─── Constants ──────────────────────────────────────────────

const TEST_PIN = '123456';
const TEST_ADMIN_TOKEN = 'showcase-admin';

const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_ROOT = emptyTree.getRoot();

// Seed data
const alice = MEMBERS[0];       // Alice Johnson (ACME-EMP-001)
const drChen = PRESCRIBERS[0];  // Dr. Sarah Chen (NPI: 1234567890)
const mainSt = PHARMACIES[0];   // Main Street Pharmacy (NPI: 2345678901)
const amoxicillin = MEDICATIONS[4]; // Amoxicillin 500mg (NDC: 00185001001)

// ─── HTTP Helpers ───────────────────────────────────────────

interface HttpResult { status: number; body: unknown }

function httpRequest(port: number, method: string, urlPath: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: urlPath, method,
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
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function post(port: number, urlPath: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'POST', urlPath, body, headers);
}
async function get(port: number, urlPath: string, headers?: Record<string, string>): Promise<HttpResult> {
  return httpRequest(port, 'GET', urlPath, undefined, headers);
}

// ─── Message Builder ───────────────────────────────────────

function buildMessage(
  senderWalletId: string,
  recipientWalletId: string,
  plaintext: string,
  threadIdHash: string,
  messageType: string = '1', // 1=clinical
) {
  const contentHash = Poseidon.hash(Encoding.stringToFields(plaintext)).toString();
  const ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
  return {
    message: {
      messageCommitment: contentHash,
      senderWalletId,
      recipientWalletId,
      messageType,
      threadIdHash,
    },
    payload: {
      ciphertext: ciphertextHex,
      iv: '000000000000000000000000',
      tag: '00000000000000000000000000000000',
      timestamp: Date.now(),
    },
  };
}

// ─── App Factory ────────────────────────────────────────────

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createApp(
  role: NautilusAppConfig['role'],
  sequencerUrl: string,
  displayName: string,
): Promise<{ server: NautilusAppServer; stateDir: string }> {
  const stateDir = await makeTempDir(`showcase-${role}-`);
  const config: NautilusAppConfig = {
    role, port: 0, host: '127.0.0.1', sequencerUrl, stateDir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: ['*'],
    adminToken: TEST_ADMIN_TOKEN, displayName,
  };
  const server = new NautilusAppServer(config);
  await server.getLocalState().unlock(TEST_PIN);
  await server.getLocalState().save({
    version: 1, role,
    onboarding: { phase: 'awaiting_token' },
    lastSavedAt: new Date().toISOString(),
  });
  return { server, stateDir };
}

// ─── Test Suite ────────────────────────────────────────────

describe('Production Showcase — Alice\'s Healthcare Journey', () => {
  let l2Node: L2Node;
  let rpcServer: L2RpcServer;
  let rpcPort: number;
  let sequencerUrl: string;
  let client: L2Client;

  let insurerApp: NautilusAppServer;
  let memberApp: NautilusAppServer;
  let prescriberApp: NautilusAppServer;
  let pharmacyApp: NautilusAppServer;

  let insurerPort: number;
  let memberPort: number;
  let prescriberPort: number;
  let pharmacyPort: number;

  // Wallet IDs captured during enrollment
  let memberWalletId: string;
  let prescriberWalletId: string;
  let pharmacyWalletId: string;

  // Thread ID for the mole conversation
  const threadIdHash = Poseidon.hash(Encoding.stringToFields('consult-mole-2026')).toString();

  const tempDirs: string[] = [];

  // ── Setup ──────────────────────────────────────────────

  beforeAll(async () => {
    // 1. Start L2Node + RPC Server
    const store = new InMemoryStore();
    l2Node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store, INITIAL_ROOT, INITIAL_ROOT, Field(0),
    );
    rpcServer = new L2RpcServer(l2Node, { port: 0, adminToken: TEST_ADMIN_TOKEN });
    await rpcServer.start();
    rpcPort = rpcServer.getPort();
    sequencerUrl = `http://127.0.0.1:${rpcPort}`;
    client = new L2Client({ sequencerUrl });

    // 2. Create 4 Nautilus Apps
    const ins = await createApp('insurer', sequencerUrl, 'ACME Insurance');
    insurerApp = ins.server; tempDirs.push(ins.stateDir);

    const mem = await createApp('member', sequencerUrl, 'Alice Johnson');
    memberApp = mem.server; tempDirs.push(mem.stateDir);

    const pre = await createApp('prescriber', sequencerUrl, 'Dr. Sarah Chen');
    prescriberApp = pre.server; tempDirs.push(pre.stateDir);

    const pha = await createApp('pharmacy', sequencerUrl, 'Main Street Pharmacy');
    pharmacyApp = pha.server; tempDirs.push(pha.stateDir);

    // 3. Register routes
    insurerApp.registerRoutes(buildInsurerRoutes(insurerApp));
    memberApp.registerRoutes(buildMemberRoutes(memberApp));
    prescriberApp.registerRoutes(buildPrescriberRoutes(prescriberApp));
    pharmacyApp.registerRoutes(buildPharmacyRoutes(pharmacyApp));

    // 4. Start HTTP servers
    await Promise.all([
      insurerApp.start(), memberApp.start(),
      prescriberApp.start(), pharmacyApp.start(),
    ]);
    insurerPort = insurerApp.getPort();
    memberPort = memberApp.getPort();
    prescriberPort = prescriberApp.getPort();
    pharmacyPort = pharmacyApp.getPort();
  }, 30_000);

  // ── Teardown ───────────────────────────────────────────

  afterAll(async () => {
    await Promise.all([
      insurerApp?.stop(), memberApp?.stop(),
      prescriberApp?.stop(), pharmacyApp?.stop(),
    ]);
    rpcServer?.stop();
    l2Node?.stop();
    for (const dir of tempDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    }
  });

  // ════════════════════════════════════════════════════════
  //  ACT 1: ENROLLMENT — Three-Party Ceremony
  // ════════════════════════════════════════════════════════

  test('P1 — insurer configures', async () => {
    const r = await post(insurerPort, '/onboarding/configure', {
      adminToken: TEST_ADMIN_TOKEN,
      insurerName: 'ACME Insurance',
    });
    expect(r.status).toBe(200);
  });

  test('P2 — Alice enrolls (member)', async () => {
    // Accept token
    let r = await post(memberPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-ALICE-001', groupId: 'ACME-CORP', planId: 'PLAN-GOLD-2026',
    });
    expect(r.status).toBe(200);

    // Import known seed enrollment key (deterministic for proof generation later)
    r = await post(memberPort, '/onboarding/generate-key', {
      enrollmentKey: alice.enrollmentKey,
    });
    expect(r.status).toBe(200);

    // Derive wallet from PHI
    r = await post(memberPort, '/onboarding/derive-wallet', {
      cardholderId: alice.localData.cardholderId,
      firstName: alice.localData.firstName,
      lastName: alice.localData.lastName,
      dateOfBirth: alice.localData.dateOfBirth,
    });
    expect(r.status).toBe(200);
    memberWalletId = (r.body as any).data.walletId;
    expect(memberWalletId).toBeDefined();

    // Enroll (notifies insurer)
    r = await post(memberPort, '/onboarding/enroll', {
      tokenId: 'TOKEN-ALICE-001',
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
  });

  test('P3 — Dr. Chen enrolls (prescriber)', async () => {
    let r = await post(prescriberPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-CHEN-001', groupId: 'ACME-PROVIDERS', planId: 'PROVIDER-PLAN',
    });
    expect(r.status).toBe(200);

    r = await post(prescriberPort, '/onboarding/generate-key', {
      enrollmentKey: drChen.enrollmentKey,
    });
    expect(r.status).toBe(200);

    r = await post(prescriberPort, '/onboarding/derive-wallet', {
      prescriberIdQualifier: drChen.localData.prescriberIdQualifier,
      prescriberId: drChen.localData.prescriberId,
    });
    expect(r.status).toBe(200);
    prescriberWalletId = (r.body as any).data.walletId;

    r = await post(prescriberPort, '/onboarding/enroll', {
      tokenId: 'TOKEN-CHEN-001',
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
  });

  test('P4 — Main Street Pharmacy enrolls', async () => {
    let r = await post(pharmacyPort, '/onboarding/accept-token', {
      tokenId: 'TOKEN-PHARM-001', groupId: 'PHARMACY-NETWORK', planId: 'PHARMACY-PLAN',
    });
    expect(r.status).toBe(200);

    r = await post(pharmacyPort, '/onboarding/generate-key', {
      enrollmentKey: mainSt.enrollmentKey,
    });
    expect(r.status).toBe(200);

    r = await post(pharmacyPort, '/onboarding/derive-wallet', {
      serviceProviderIdQualifier: mainSt.localData.serviceProviderIdQualifier,
      serviceProviderId: mainSt.localData.serviceProviderId,
    });
    expect(r.status).toBe(200);
    pharmacyWalletId = (r.body as any).data.walletId;

    r = await post(pharmacyPort, '/onboarding/enroll', {
      tokenId: 'TOKEN-PHARM-001',
      insurerUrl: `http://127.0.0.1:${insurerPort}`,
    });
    expect(r.status).toBe(200);
  });

  // ════════════════════════════════════════════════════════
  //  ACT 2: PCP ASSIGNMENT — Alice picks Dr. Chen
  // ════════════════════════════════════════════════════════

  test('P5 — Alice assigns Dr. Chen as her PCP', async () => {
    const r = await post(memberPort, '/pcp/assign', {
      pcpWalletId: prescriberWalletId,
      effectiveDate: '20260215',
      specialty: 'Internal Medicine',
      consentScopeFlags: 7, // PCP_SCOPE_ALL
    });
    expect(r.status).toBe(200);
    const data = (r.body as any).data;
    expect(data.pcpWalletId).toBe(prescriberWalletId);
    expect(data.commitment).toBeDefined();
    expect(data.consentScopeFlags).toBe(7);
  });

  test('P5 — Alice can query her PCP assignment', async () => {
    const r = await get(memberPort, '/pcp/current');
    expect(r.status).toBe(200);
  });

  // ════════════════════════════════════════════════════════
  //  ACT 3: COMPILE + REGISTER — Real ZK Proofs
  // ════════════════════════════════════════════════════════

  test('P6 — compile StateTransitionProgram on all entities', async () => {
    // Serial compilation (o1js global state)
    let r = await post(memberPort, '/onboarding/compile');
    expect(r.status).toBe(200);
    expect((r.body as any).data.phase).toBe('ready');

    r = await post(prescriberPort, '/onboarding/compile');
    expect(r.status).toBe(200);

    r = await post(pharmacyPort, '/onboarding/compile');
    expect(r.status).toBe(200);
  }, 120_000);

  test('P7 — Alice generates registration proof', async () => {
    const r = await post(memberPort, '/proof/registration');
    if (r.status !== 200) console.error('Member proof error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).data.proofGenerated).toBe(true);
    expect((r.body as any).data.submittedToSequencer).toBe(true);
  }, 300_000);

  test('P7 — Dr. Chen generates registration proof', async () => {
    const r = await post(prescriberPort, '/proof/registration');
    if (r.status !== 200) console.error('Prescriber proof error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).data.proofGenerated).toBe(true);
  }, 300_000);

  test('P7 — Main Street Pharmacy generates registration proof', async () => {
    const r = await post(pharmacyPort, '/proof/registration');
    if (r.status !== 200) console.error('Pharmacy proof error:', JSON.stringify(r.body, null, 2));
    expect(r.status).toBe(200);
    expect((r.body as any).data.proofGenerated).toBe(true);
  }, 300_000);

  // ════════════════════════════════════════════════════════
  //  ACT 4: BATCH #1 — Settlement of Registrations
  // ════════════════════════════════════════════════════════

  test('P8 — force batch #1 (3 registrations)', async () => {
    const r = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0', id: 1, method: 'l2_forceBatch',
    }, { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` });
    expect(r.status).toBe(200);
  });

  test('P8 — chain state shows 3 registered wallets', async () => {
    const r = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0', id: 2, method: 'l2_getStatus',
    });
    expect(r.status).toBe(200);
    expect((r.body as any).result.currentWalletCount).toBe('3');
  });

  test('P8 — insurer sees 3 receipts', async () => {
    const r = await get(insurerPort, '/receipts/all');
    expect(r.status).toBe(200);
    expect((r.body as any).data).toHaveLength(3);
  });

  test('P8 — audit chain integrity holds', async () => {
    const r = await get(insurerPort, '/audit/chain-integrity');
    expect(r.status).toBe(200);
    expect((r.body as any).data.isValid).toBe(true);
  });

  // ════════════════════════════════════════════════════════
  //  ACT 5: MESSAGING — The Mole Conversation
  // ════════════════════════════════════════════════════════

  test('P9 — Alice: "I have a massive mole on the side of my arm"', async () => {
    const msg = buildMessage(
      memberWalletId, prescriberWalletId,
      'I have a massive mole on the side of my arm',
      threadIdHash,
    );
    const r = await post(memberPort, '/messaging/send', msg);
    expect(r.status).toBe(200);
    expect((r.body as any).data.leafIndex).toBeDefined();
  });

  test('P10 — Dr. Chen checks inbox, sees Alice\'s message', async () => {
    const r = await get(prescriberPort, '/messaging/inbox');
    expect(r.status).toBe(200);
    const messages = (r.body as any).data;
    expect(messages).toHaveLength(1);
    expect(messages[0].message.senderWalletId).toBe(memberWalletId);
    expect(messages[0].message.threadIdHash).toBe(threadIdHash);
  });

  test('P11 — Dr. Chen: "It\'s not moles, it\'s cancer!"', async () => {
    const msg = buildMessage(
      prescriberWalletId, memberWalletId,
      "It's not moles, it's cancer!",
      threadIdHash,
    );
    const r = await post(prescriberPort, '/messaging/send', msg);
    expect(r.status).toBe(200);
  });

  test('P12 — Alice: "OK prescribe me amoxicillin then"', async () => {
    const msg = buildMessage(
      memberWalletId, prescriberWalletId,
      'OK prescribe me amoxicillin then',
      threadIdHash,
    );
    const r = await post(memberPort, '/messaging/send', msg);
    expect(r.status).toBe(200);
  });

  test('P13 — message thread has 3 messages in conversation', async () => {
    const r = await get(memberPort, `/messaging/thread/${threadIdHash}`);
    expect(r.status).toBe(200);
    const messages = (r.body as any).data;
    expect(messages).toHaveLength(3);
  });

  test('P13 — insurer message store shows 3 messages', async () => {
    const r = await get(insurerPort, '/messaging/status');
    expect(r.status).toBe(200);
    expect((r.body as any).data.messageCount).toBe('3');
  });

  // ════════════════════════════════════════════════════════
  //  ACT 6: THE PRESCRIPTION — Amoxicillin 500mg
  //  (In-process: compile + build data + generate proofs)
  // ════════════════════════════════════════════════════════

  test('P14 — compile AccumulatorFulfillmentProgram', async () => {
    await AccumulatorFulfillmentProgram.compile();
  }, 300_000);

  test('P15 — build prescription + fulfillment data and generate claim proof', async () => {
    // ─── Derive wallet IDs from seed data ──────────────────
    const memberWid = deriveMemberWalletId(alice.localData, alice.enrollmentKey, Field(0));
    const prescriberWid = derivePrescriberWalletId(drChen.localData, drChen.enrollmentKey);
    const pharmacyWid = derivePharmacyWalletId(mainSt.localData, mainSt.enrollmentKey);

    // ─── Set up formulary + plan ───────────────────────────
    const formularyEntries = getAllFormularyEntries();
    const planTemplate = new PlanTemplate({
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP',
      copayAmountCents: 3000,
      coverageType: 1,
      deductibleAmountCents: 50000,
      oopMaxCents: 800000,
      annualBenefitMaxCents: 0,
      formularyEntries,
    });
    const formularyRegistry = planTemplate.formularyRegistry;

    // ─── Build EligibilityData ─────────────────────────────
    const eligibilityData = new EligibilityData({
      planIdHash: hashString('PLAN-GOLD-2026'),
      groupIdHash: hashString('ACME-CORP'),
      effectiveDate: dateToField('20260101'),
      terminationDate: Field(0),
      copayAmountCents: centsToField(3000),
      coverageType: Field(1),
      formularyRoot: formularyRegistry.getRoot(),
      networkRoot: Field(0),
    });

    // ─── Build AccumulatorData ($500 deductible, $0 paid) ──
    const accumulatorData = new AccumulatorData({
      planYear: dateToField('20260101'),
      deductibleAmountCents: centsToField(50000),
      deductiblePaidCents: centsToField(0),
      oopMaxCents: centsToField(800000),
      oopPaidCents: centsToField(0),
      annualBenefitMaxCents: centsToField(0),
      annualBenefitUsedCents: centsToField(0),
    });

    // ─── Build Eligibility Credential Forest ───────────────
    const eligForest = new MerkleForest();
    eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligibilityData.commitment());
    eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumulatorData.commitment());

    const eligCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      forestRoot: eligForest.getForestRoot(),
      issuerWalletId: Field(0), // admin
      subjectWalletId: memberWid,
      issuedAt: dateToField('20260201'),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // ─── Build PrescriptionData (Amoxicillin 500mg) ────────
    const ndcCode = amoxicillin.ndc; // '00185001001'
    const prescriptionData = new PrescriptionData({
      ndcHash: hashString(ndcCode),
      prescriberWalletId: prescriberWid,
      memberWalletId: memberWid,
      writtenDate: dateToField('20260215'),
      expirationDate: dateToField('20270215'),
      quantityPrescribed: quantityToField(30),
      refillsAuthorized: Field(3n),
    });

    // ─── Prescription Status: ACTIVE → FILLED ──────────────
    const activeStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_ADJUDICATED,
      updatedByWalletId: prescriberWid,
      updatedAt: dateToField('20260215'),
      pharmacyWalletId: pharmacyWid,
      fillQuantity: Field(0),
      notesHash: Field(0),
    });

    const filledStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_FILLED,
      updatedByWalletId: pharmacyWid,
      updatedAt: dateToField('20260215'),
      pharmacyWalletId: pharmacyWid,
      fillQuantity: quantityToField(30),
      notesHash: Field(0),
    });

    // ─── Build Rx Credential Forest ────────────────────────
    const rxForest = new MerkleForest();
    rxForest.setLeaf(ForestDomain.MEDICATION, 0n, prescriptionData.commitment());
    rxForest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());
    // After pharmacy fills, FILLED status goes at slot 1
    rxForest.setLeaf(ForestDomain.TRANSACTION, 1n, filledStatus.commitment());

    const rxForestRoots = ForestRoots.fromForest(rxForest);

    const rxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: prescriberWid,
      subjectWalletId: pharmacyWid,
      issuedAt: dateToField('20260215'),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // ─── Build FulfillmentData ─────────────────────────────
    // Amoxicillin: $12/unit AWP × 30 caps = $360 AWP, package price = $3.60
    // ingredientCost = $3.60, dispensingFee = $0 for generic
    const fulfillmentData = new FulfillmentData({
      prescriptionHash: prescriptionData.commitment(),
      pharmacyWalletId: pharmacyWid,
      ndcHash: hashString(ndcCode),
      quantityDispensed: quantityToField(30),
      ingredientCostCents: centsToField(360), // $3.60
      dispensingFeeCents: centsToField(0),
      dateOfService: dateToField('20260215'),
    });

    // ─── Build FormularyEntry ──────────────────────────────
    const formularyEntry = buildFormularyEntry(amoxicillin.formularyEntry);

    // ─── Collect witnesses ─────────────────────────────────
    // Rx credential witnesses
    const fulfMedWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
    const fulfStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 1n);
    // New fulfillment settlement slot at TRANSACTION tree index 2
    const fulfNewSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 2n);
    // Formulary witness
    // Amoxicillin = MEDICATIONS[4] → formulary index 4n (sequential addEntry)
    const formEntryIndex = 4n;
    const fulfFormWitness = formularyRegistry.getEntryWitness(formEntryIndex);
    // Eligibility credential witnesses
    const eligForestRoots = ForestRoots.fromForest(eligForest);
    const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
    // Pharmacy identity preimage (3 fields)
    const pharmaPreimage = pharmacyWalletPreimage(mainSt.localData, mainSt.enrollmentKey);

    // ─── THE CLAIM — AccumulatorFulfillment proof ──────────
    const fulfillResult = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
      rxCredentialData,
      prescriptionData,
      filledStatus,
      fulfillmentData,
      formularyEntry,
      rxForestRoots,
      fulfMedWitness,
      fulfStatusWitness,
      fulfNewSlotWitness,
      fulfFormWitness,
      eligibilityData.formularyRoot,
      eligCredentialData,
      eligForestRoots,
      accumulatorData,
      accumWitness,
      pharmaPreimage[0],
      pharmaPreimage[1],
      pharmaPreimage[2],
    );

    const output = fulfillResult.proof.publicOutput;

    // ─── Verify adjudication results ───────────────────────
    // In deductible phase: $3.60 total < $500 remaining deductible
    // Patient pays full cost, plan pays $0
    const patientPay = Number(output.patientPayCents.toBigInt());
    const planPay = Number(output.planPayCents.toBigInt());
    expect(patientPay).toBe(360);  // $3.60
    expect(planPay).toBe(0);       // $0 — still in deductible
    expect(output.operationType.toBigInt()).toBe(1n); // fulfillment (not reversal)

    // Deductible credit should equal patient pay
    const deductibleCredit = Number(output.deductibleCreditCents.toBigInt());
    expect(deductibleCredit).toBe(360); // $3.60 applied to deductible

    // NDC hash matches Amoxicillin
    expect(output.ndcHash.toBigInt()).toBe(hashString(ndcCode).toBigInt());

    // New eligibility forest root changed (accumulator updated)
    expect(output.newEligibilityForestRoot.toBigInt()).not.toBe(eligForest.getForestRoot().toBigInt());
  }, 300_000);

  // ════════════════════════════════════════════════════════
  //  ACT 7: WALLET UPDATE — Submit to Sequencer
  // ════════════════════════════════════════════════════════

  test('P16 — generate wallet update proof and submit to sequencer', async () => {
    // Fetch witnesses for Alice's existing wallet slot
    const witnesses = await client.getWalletWitnesses(memberWalletId);

    // Deserialize witnesses
    const regWitnessData = typeof witnesses.registryWitnessJson === 'string'
      ? JSON.parse(witnesses.registryWitnessJson)
      : witnesses.registryWitnessJson;
    const lcWitnessData = typeof witnesses.lifecycleWitnessJson === 'string'
      ? JSON.parse(witnesses.lifecycleWitnessJson)
      : witnesses.lifecycleWitnessJson;

    const regWitness = WalletRegistryWitness.fromJSON(regWitnessData);
    const lcWitness = LifecycleWitness.fromJSON(lcWitnessData);
    const regRoot = Field(BigInt(witnesses.currentRegistryRoot));
    const lcRoot = Field(BigInt(witnesses.currentLifecycleRoot));

    // Build a new credential root (simulates updated forest after fulfillment)
    const newCredentialRoot = Poseidon.hash([EMPTY_CREDENTIAL_ROOT, Field(1)]); // Deterministic update

    // Generate wallet update proof using already-compiled StateTransitionProgram
    // Member preimage: need domainTag (0) + 5 wallet fields
    const memberWid = deriveMemberWalletId(alice.localData, alice.enrollmentKey, Field(0));
    const { memberWalletPreimage } = await import('../src/wallets/wallet-derivation.js');
    const walletFields = memberWalletPreimage(alice.localData, alice.enrollmentKey, Field(0));
    const padded = [...walletFields];
    while (padded.length < 6) padded.push(Field(0));

    const result = await StateTransitionProgram.proveWalletUpdate(
      Field(0),        // domainTag = MEMBER
      padded[0],       // f0 = hash(cardholderId)
      padded[1],       // f1 = hashDate(dob)
      padded[2],       // f2 = hash(firstName)
      padded[3],       // f3 = hash(lastName)
      padded[4],       // f4 = hash(enrollmentKey)
      padded[5],       // f5 = groupIdHash
      EMPTY_CREDENTIAL_ROOT,  // old credential root (initial after registration)
      Field(0),               // old nonce (0 after registration)
      newCredentialRoot,      // new credential root (after fulfillment)
      regWitness,
      lcWitness,
      regRoot,
      lcRoot,
      Field(BigInt(witnesses.currentLifecycleState)),   // actual lifecycle state from sequencer
    );

    // Verify it's a wallet update (not registration)
    const output = result.proof.publicOutput;
    expect(output.walletId.toBigInt().toString()).toBe(memberWalletId);
    // Lifecycle roots unchanged (only registry changes for wallet update)
    expect(output.oldLifecycleRoot.toBigInt()).toBe(output.newLifecycleRoot.toBigInt());

    // Submit to sequencer via L2Client RPC
    const receipt = await client.submitProof(result.proof);
    expect(receipt.receiptId).toBeDefined();
    expect(receipt.isRegistration).toBe(false); // wallet UPDATE, not registration
    expect(receipt.walletId).toBe(memberWalletId);
  }, 300_000);

  // ════════════════════════════════════════════════════════
  //  ACT 8: BATCH #2 — Settlement of Wallet Update
  // ════════════════════════════════════════════════════════

  test('P17 — force batch #2 (wallet update)', async () => {
    const r = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0', id: 10, method: 'l2_forceBatch',
    }, { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` });
    expect(r.status).toBe(200);
  });

  test('P17 — wallet count still 3 (update, not new registration)', async () => {
    const r = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0', id: 11, method: 'l2_getStatus',
    });
    expect(r.status).toBe(200);
    expect((r.body as any).result.currentWalletCount).toBe('3');
    expect((r.body as any).result.totalProofsAccepted).toBe(4);
  });

  test('P17 — insurer sees 4 total receipts', async () => {
    const r = await get(insurerPort, '/receipts/all');
    expect(r.status).toBe(200);
    const receipts = (r.body as any).data;
    expect(receipts).toHaveLength(4);
    // 3 registrations + 1 wallet update
    const registrations = receipts.filter((r: any) => r.isRegistration);
    const updates = receipts.filter((r: any) => !r.isRegistration);
    expect(registrations).toHaveLength(3);
    expect(updates).toHaveLength(1);
  });

  // ════════════════════════════════════════════════════════
  //  ACT 9: VERIFICATION — Audit + Reports
  // ════════════════════════════════════════════════════════

  test('P18 — audit chain integrity holds after all operations', async () => {
    const r = await get(insurerPort, '/audit/chain-integrity');
    expect(r.status).toBe(200);
    expect((r.body as any).data.isValid).toBe(true);
  });

  test('P18 — audit log has 4 events', async () => {
    const r = await get(insurerPort, '/audit/log');
    expect(r.status).toBe(200);
    const log = (r.body as any).data;
    expect(log.events).toHaveLength(4);
  });

  test('P19 — member proof timings recorded', async () => {
    const r = await get(memberPort, '/proof-timings');
    expect(r.status).toBe(200);
    const timings = (r.body as any).data;
    expect(timings.length).toBeGreaterThan(0);
  });

  test('P19 — prescriber proof timings recorded', async () => {
    const r = await get(prescriberPort, '/proof-timings');
    expect(r.status).toBe(200);
    expect((r.body as any).data.length).toBeGreaterThan(0);
  });

  test('P19 — pharmacy proof timings recorded', async () => {
    const r = await get(pharmacyPort, '/proof-timings');
    expect(r.status).toBe(200);
    expect((r.body as any).data.length).toBeGreaterThan(0);
  });

  test('P20 — Alice can query her receipts', async () => {
    const r = await get(memberPort, '/receipts');
    expect(r.status).toBe(200);
    const receipts = (r.body as any).data;
    // Alice has at least her registration receipt
    expect(receipts.length).toBeGreaterThanOrEqual(1);
  });

  test('P20 — message store status on insurer', async () => {
    const r = await get(insurerPort, '/messaging/status');
    expect(r.status).toBe(200);
    expect((r.body as any).data.messageCount).toBe('3');
  });

  test('P20 — NFC identity payload available for Alice', async () => {
    const r = await get(memberPort, '/nfc/id-payload');
    expect(r.status).toBe(200);
    const nfc = (r.body as any).data;
    expect(nfc.record).toBeDefined();
    expect(nfc.tagCompatibility).toBeDefined();
  });

  test('P20 — registration witnesses now at slot 3', async () => {
    const r = await post(rpcPort, '/rpc', {
      jsonrpc: '2.0', id: 20, method: 'l2_getRegistrationWitnesses',
    });
    expect(r.status).toBe(200);
    expect((r.body as any).result.nextSlotIndex).toBe('3');
  });
});
