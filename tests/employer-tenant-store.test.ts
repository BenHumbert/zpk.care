/**
 * The employer node keeps its groups, roster and invites across a restart — A-136 (owner, 2026-11-04: save the invites
 * without letting them leak).
 *
 * The employer tenant kept everything in memory and ended with the plan's process that spawned it, so after a restart
 * every unused invite was unknown, the roster forgot who enrolled, the enrollment cap counted from zero, and activation
 * started an empty tenant on a new port with a new admin token. Now:
 *
 *  - The tenant keeps its records in a sealed store (src/keys/sealed-store.ts) under a key the plan derives for that one
 *    employer from its ceremony-made master, handed to the tenant on stdin, never in its environment or on its disk.
 *  - The store holds what the node held, hashes only: no code (A-109), no wallet ID (I6), and not the PIN hash either,
 *    but an HMAC of it under a second per-employer key, so a copy of the records cannot be tried against PINs even by
 *    someone who also holds a code.
 *  - The plan keeps a sealed registry of its activated tenants and brings each back after its own restart, on the same
 *    port, with the same admin token, which the tenant checks against its SHA-256 (the plan keeps no token once the
 *    employer has collected it).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { Poseidon } from 'o1js';
import { hashString } from '../src/zkp/hash-utils.js';
import { EmployerNode } from '../src/nodes/employer-node.js';
import type { EmployerStoredRecord } from '../src/nodes/employer-node.js';
import { SealedRecordStore } from '../src/keys/sealed-store.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { buildEmployerRoutes } from '../src/nodes/routes/employer-routes.js';
import type { EmployerAttestation } from '../src/l2/l2-types.js';

const EMPLOYER = 'ACME-STORE';
const PLAN = 'PLAN-GOLD';
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const pinHashOf = (code: string, pin: string) => Poseidon.hash([hashString(code), hashString(pin)]).toString();

const attestation = {
  employerId: EMPLOYER,
  publicKeyHex: 'ab'.repeat(32),
  authorizedPlanIds: [PLAN],
  insurerPublicKeyHex: 'cd'.repeat(32),
} as unknown as EmployerAttestation;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-store-'));
});
// a tenant process may still be letting go of its files on Windows
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function openNode(key: Buffer, pepper: Buffer): { node: EmployerNode; store: SealedRecordStore<EmployerStoredRecord> } {
  const store = SealedRecordStore.open<EmployerStoredRecord>({ dir: path.join(dir, 'records'), name: 'employer', key });
  const node = new EmployerNode({ role: 'employer', sequencerUrl: 'http://127.0.0.1:9', employerId: EMPLOYER, store, pinPepper: pepper });
  node.setRequireAttestation(true);
  node.setAttestation(attestation);
  return { node, store };
}

describe('the employer node with a sealed store', () => {
  const key = randomBytes(32);
  const pepper = randomBytes(32);

  test('its groups, roster and invites survive a restart, and an invite issued before it still enrolls', () => {
    const first = openNode(key, pepper);
    first.node.createGroup('G1', PLAN, '20260101', 10);
    const empHash = Poseidon.hash([hashString('employee-1')]).toString();
    const { tokenId } = first.node.generateToken('G1', empHash, empHash, inDays(7));
    first.node.setTokenPinHash(tokenId, pinHashOf(tokenId, '12345678'));
    first.store.close();

    const second = openNode(key, pepper);
    expect(second.node.listGroups().map((g) => g.groupId)).toEqual(['G1']);
    expect(second.node.getRosterEntry(empHash)?.status).toBe('pending');
    expect(second.node.listRoster()[0].inviteStatus).toBe('unused');
    const redeemed = second.node.redeemTokenWithPin(tokenId, today(), pinHashOf(tokenId, '12345678'));
    expect(redeemed).toMatchObject({ valid: true, consumed: true });
    second.store.close();

    const third = openNode(key, pepper);
    expect(third.node.getRosterEntry(empHash)?.status).toBe('enrolled');
    expect(third.node.getGroup('G1')?.enrolledCount).toBe(1);
    expect(third.node.listRoster()[0].inviteStatus).toBe('consumed');
    // the code is spent for good, across the restart
    expect(third.node.redeemTokenWithPin(tokenId, today(), pinHashOf(tokenId, '12345678')).valid).toBe(false);
    // and the next code is new: the nonce counter came back too
    const other = Poseidon.hash([hashString('employee-2')]).toString();
    expect(third.node.generateToken('G1', other, other, inDays(7)).tokenId).not.toBe(tokenId);
    third.store.close();
  });

  test('the store keeps no code, no PIN hash and no wallet ID', () => {
    const first = openNode(key, pepper);
    first.node.createGroup('G1', PLAN, '20260101');
    const empHash = Poseidon.hash([hashString('employee-1')]).toString();
    const { tokenId } = first.node.generateToken('G1', empHash, empHash, inDays(7));
    const pinHash = pinHashOf(tokenId, '12345678');
    first.node.setTokenPinHash(tokenId, pinHash);
    first.node.redeemTokenWithPin(tokenId, today(), pinHash);
    const kept = JSON.stringify([...first.store.entries()]);
    expect(kept).not.toContain(tokenId);
    expect(kept).not.toContain(pinHash);
    expect(kept).not.toContain('consumedByWalletId');
    expect(kept).toContain('pinCheck');
    first.store.close();
  });

  test('wrong PINs count toward the lock across a restart', () => {
    const first = openNode(key, pepper);
    first.node.createGroup('G1', PLAN, '20260101');
    const empHash = Poseidon.hash([hashString('employee-1')]).toString();
    const { tokenId } = first.node.generateToken('G1', empHash, empHash, inDays(7));
    first.node.setTokenPinHash(tokenId, pinHashOf(tokenId, '12345678'));
    for (let i = 0; i < 3; i++) first.node.redeemTokenWithPin(tokenId, today(), pinHashOf(tokenId, '00000000'));
    first.store.close();
    const second = openNode(key, pepper);
    for (let i = 0; i < 2; i++) second.node.redeemTokenWithPin(tokenId, today(), pinHashOf(tokenId, '00000000'));
    expect(second.node.redeemTokenWithPin(tokenId, today(), pinHashOf(tokenId, '12345678')).reason).toMatch(/locked/);
    second.store.close();
  });

  test('without the PIN key, the records cannot check a PIN', () => {
    const first = openNode(key, pepper);
    first.node.createGroup('G1', PLAN, '20260101');
    const empHash = Poseidon.hash([hashString('employee-1')]).toString();
    const { tokenId } = first.node.generateToken('G1', empHash, empHash, inDays(7));
    first.node.setTokenPinHash(tokenId, pinHashOf(tokenId, '12345678'));
    first.store.close();
    const second = openNode(key, randomBytes(32));
    expect(second.node.redeemTokenWithPin(tokenId, today(), pinHashOf(tokenId, '12345678')).valid).toBe(false);
    second.store.close();
  });

  test('a store needs its PIN key', () => {
    const store = SealedRecordStore.open<EmployerStoredRecord>({ dir: path.join(dir, 'records'), name: 'employer', key });
    expect(() => new EmployerNode({ role: 'employer', sequencerUrl: 'http://127.0.0.1:9', employerId: EMPLOYER, store })).toThrow(
      /PIN key/,
    );
    store.close();
  });

  test('without a store the node keeps its records in memory, as before', () => {
    const node = new EmployerNode({ role: 'employer', sequencerUrl: 'http://127.0.0.1:9', employerId: EMPLOYER });
    node.setAttestation(attestation);
    node.createGroup('G1', PLAN, '20260101');
    expect(node.listGroups()).toHaveLength(1);
  });
});

describe('an admin token checked against its hash', () => {
  test('the right bearer is accepted and any other refused', async () => {
    const token = `${EMPLOYER.toLowerCase()}-admin-${randomBytes(16).toString('hex')}`;
    const server = new NautilusAppServer({
      role: 'employer',
      port: 0,
      host: '127.0.0.1',
      sequencerUrl: 'http://127.0.0.1:9',
      stateDir: dir,
      enableSSE: false,
      maxSseConnections: 0,
      allowedOrigins: [],
      adminTokenSha256: createHash('sha256').update(token).digest('hex'),
    } as unknown as NautilusAppConfig);
    server.registerRoutes(buildEmployerRoutes(server));
    const node = new EmployerNode({ role: 'employer', sequencerUrl: 'http://127.0.0.1:9', employerId: EMPLOYER });
    node.setAttestation(attestation);
    server.setEntityNode(node);
    await server.start();
    const url = `http://127.0.0.1:${server.getPort()}`;
    try {
      expect((await fetch(`${url}/groups`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
      expect((await fetch(`${url}/groups`, { headers: { Authorization: `Bearer ${token}x` } })).status).toBe(401);
      expect((await fetch(`${url}/groups`, { headers: { Authorization: 'Bearer ' } })).status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});

describe('the plan brings its tenants back after its own restart', () => {
  let sequencer: http.Server;
  let sequencerUrl: string;
  const employerPubKeyHex = 'ab'.repeat(32);

  beforeAll(async () => {
    // a stand-in sequencer: the employer's attestation, and a tenant registry that takes whatever it is sent
    sequencer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => {
        raw += d;
      });
      req.on('end', () => {
        const call = JSON.parse(raw || '{}') as { id?: number; method?: string };
        const result = (() => {
          switch (call.method) {
            case 'l2_getEmployerNode':
              return null;
            case 'l2_getEmployerAttestation':
              return { employerId: EMPLOYER, publicKeyHex: employerPubKeyHex };
            case 'l2_verifyEmployer':
              return { valid: true, attestation: { ...attestation, publicKeyHex: employerPubKeyHex } };
            case 'l2_registerEmployerNode':
              return { registered: true };
            case 'l2_deregisterEmployerNode':
              return { deregistered: true };
            default:
              return null;
          }
        })();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 1, result }));
      });
    });
    await new Promise<void>((resolve) => sequencer.listen(0, '127.0.0.1', () => resolve()));
    sequencerUrl = `http://127.0.0.1:${(sequencer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => sequencer.close(() => resolve()));
  });

  test('same port, same token, same records; the plan keeps the token only until it is collected', async () => {
    // the helper is waited for without blocking, since the stand-in sequencer above runs in this process
    const helper = path.join(__dirname, 'helpers', 'tenant-respawn.ts');
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', helper, sequencerUrl, dir, EMPLOYER, employerPubKeyHex, PLAN], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let text = '';
      child.stdout.on('data', (d: Buffer) => {
        text += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        text += d.toString();
      });
      child.on('close', () => resolve(text));
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('@@tenant-respawn '));
    if (!line) throw new Error(`the helper printed no result:\n${out.slice(-3000)}`);
    const r = JSON.parse(line.slice('@@tenant-respawn '.length));
    if (r.error) throw new Error(`the helper failed: ${r.error}\n${out.slice(-3000)}`);
    expect(r.createdGroup).toBe(201);
    expect(r.tokenIssued).toBe(true);
    // the plan keeps the token's hash, and the token itself only until the employer collects it
    expect(r.adminTokenSha256Matches).toBe(true);
    expect(r.pendingBeforeCollection).toBe(true);
    expect(r.pendingAfterCollection).toBeNull();
    expect(r.registryHoldsToken).toBe(false);
    // after the plan's restart: the same URL, the same token, the group and the invite
    expect(r.back).toEqual([{ employerId: EMPLOYER, employerNodeUrl: r.employerNodeUrl, ok: true }]);
    expect(r.groupsAfter).toEqual([{ groupId: 'G1', pendingTokens: 1 }]);
    expect(r.inviteAfter).toBe(200);
    expect(r.wrongToken).toBe(401);
  }, 240_000);
});
