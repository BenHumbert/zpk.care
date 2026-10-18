/**
 * The engine's door — plan item B2 (now), finding A-6, with C2's approval route.
 *
 * A real L2RpcServer carries the engine's routes against a stand-in service that implements only
 * what these routes touch. `approve-member` takes the operator's bearer or the insurer's key and
 * refuses a member's key; `register-member` answers 403 for a wallet nobody approved, 409 when the
 * gate finds no registration on the ledger, and passes through once both hold.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { RegistrationRefused, type AdjudicationService, type MemberApproval } from '../src/adjudication/interactive-service.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const insurer = generateNodeKey('insurer');
const member = generateNodeKey('member');

/** Only what the routes under test call. Everything else throws so a wider dependency shows up. */
function standInService() {
  const approvals = new Map<string, MemberApproval>();
  const registered = new Set<string>();
  const svc = {
    approveMember(a: Omit<MemberApproval, 'approvedAt'>) {
      const existing = approvals.get(a.walletId);
      if (existing) {
        if (existing.planId !== a.planId || existing.groupIdHash !== a.groupIdHash) throw new RegistrationRefused(409, 'already approved under a different group or plan');
        return { approved: true as const, alreadyApproved: true };
      }
      approvals.set(a.walletId, { ...a, approvedAt: Date.now() });
      return { approved: true as const, alreadyApproved: false };
    },
    approvalFor(walletId: string) { return approvals.get(walletId); },
    async registerMemberFromEnrollment(opts: { walletId: string; preimageFields: string[]; displayName: string }) {
      // the same order the engine applies: approval, then the ledger, then the rest
      if (!approvals.has(opts.walletId)) throw new RegistrationRefused(403, 'This wallet has no insurer approval: complete enrollment with the insurer first');
      if (!registered.has(opts.walletId)) throw new RegistrationRefused(409, 'The wallet is not registered on the ledger yet: submit the registration proof first');
      return { walletId: opts.walletId, displayName: opts.displayName, planId: approvals.get(opts.walletId)!.planId };
    },
    getState() { return { compiled: true, enrolledMembers: [] }; },
    __registered: registered,
  };
  return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in service has no ${p}`); return undefined; } }) as unknown as AdjudicationService & { __registered: Set<string> };
}

let server: L2RpcServer;
let url: string;
let service: ReturnType<typeof standInService>;

const signed = (key: { nodeId: string; seedHex: string }, p: string, body: string) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: p, body });
async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}
const approval = { walletId: '123456789', groupIdHash: '777', planIdHash: '888', planId: 'PLAN-E2E-TEST', employerId: 'EMP-1' };
const sixFields = ['1', '2', '3', '4', '5', '6'];

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-gate-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(insurer.nodeId, insurer.publicKeyHex, 'insurer');
  server.registerNodeKey(member.nodeId, member.publicKeyHex, 'member');
  service = standInService();
  registerInteractiveRoutes(server, service);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server.stop(); });

describe('approve-member', () => {
  test('is admin-gated: unsigned 401, a member key 403, the insurer key and the operator bearer 200', async () => {
    const body = JSON.stringify(approval);
    expect((await post('/interactive/approve-member', approval)).status).toBe(401);
    expect((await post('/interactive/approve-member', approval, signed(member, '/interactive/approve-member', body))).status).toBe(403);
    const ok = await post('/interactive/approve-member', approval, signed(insurer, '/interactive/approve-member', body));
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ approved: true, alreadyApproved: false, walletId: approval.walletId });
    const again = await post('/interactive/approve-member', approval, { Authorization: `Bearer ${OPERATOR}` });
    expect(again.status).toBe(200);
    expect(again.json.alreadyApproved).toBe(true);
  });

  test('validates its body and refuses a conflicting re-approval', async () => {
    expect((await post('/interactive/approve-member', { walletId: 'x' }, { Authorization: `Bearer ${OPERATOR}` })).status).toBe(400);
    const conflict = await post('/interactive/approve-member', { ...approval, planId: 'OTHER' }, { Authorization: `Bearer ${OPERATOR}` });
    expect(conflict.status).toBe(409);
  });
});

describe('register-member', () => {
  test('refuses a wallet nobody approved with 403, and says so', async () => {
    const r = await post('/interactive/register-member', { walletId: '42', preimageFields: sixFields, displayName: 'Mallory' });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/no insurer approval/);
  });

  test('an approved wallet with no registration on the ledger is 409, and passes once registered', async () => {
    const early = await post('/interactive/register-member', { walletId: approval.walletId, preimageFields: sixFields, displayName: 'Alice' });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/not registered on the ledger/);
    service.__registered.add(approval.walletId);
    const ok = await post('/interactive/register-member', { walletId: approval.walletId, preimageFields: sixFields, displayName: 'Alice', planId: 'IGNORED', groupId: 'IGNORED' });
    expect(ok.status).toBe(200);
    expect(ok.json.planId).toBe('PLAN-E2E-TEST'); // from the approval, never from the body
  });

  test('still validates its own body first', async () => {
    expect((await post('/interactive/register-member', { walletId: '42' })).status).toBe(400);
  });
});
