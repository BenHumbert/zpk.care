/**
 * Node roles and per-node credentials — plan item A9 (remainder), finding A-14.
 *
 * The role tables are the single source of truth for what a node's key may do on the sequencer;
 * the derivation gives a node an admin token of its own that cannot be turned back into the
 * operator's; a child process is started with none of its parent's secrets.
 */
import { verify as ed25519Verify, createPublicKey } from 'crypto';
import {
  NODE_ROLES, isNodeRole, roleMayCall, RPC_METHODS_BY_ROLE, ROUTES_BY_ROLE,
  deriveNodeAdminToken, generateNodeKey, publicKeyHexFromSeed, nodeKeyFromEnv,
  childEnvironment, SECRET_ENV_KEYS, NODE_ID_ENV, NODE_KEY_SEED_ENV,
} from '../src/security/node-roles';
import { signRequest, verifySignedRequest, privateKeyFromSeedHex, signerIdFromHeaders } from '../src/security/signed-request';

describe('role tables', () => {
  test('the operator may do everything; every other role only what its table lists', () => {
    expect(roleMayCall('operator', { kind: 'rpc', method: 'l2_forceBatch' })).toBe(true);
    expect(roleMayCall('operator', { kind: 'route', method: 'POST', path: '/interactive/reset' })).toBe(true);
    for (const role of NODE_ROLES) {
      if (role === 'operator') continue;
      expect(roleMayCall(role, { kind: 'rpc', method: 'l2_forceBatch' })).toBe(false);
      // A13: a replica pulls the leader's snapshot when it connects; no other role may
      expect(roleMayCall(role, { kind: 'rpc', method: 'l2_requestSnapshot' })).toBe(role === 'replica');
      expect(roleMayCall(role, { kind: 'rpc', method: 'l2_revokeAdminKey' })).toBe(false);
      expect(roleMayCall(role, { kind: 'route', method: 'POST', path: '/interactive/reset' })).toBe(false);
      expect(roleMayCall(role, { kind: 'route', method: 'POST', path: '/interactive/decrypt-thread' })).toBe(false);
    }
  });

  test('the insurer may credential providers and manage plans, formularies and employers, and nothing of the operator\'s', () => {
    for (const m of ['l2_credentialProvider', 'l2_updateProviderStatus', 'l2_publishPlanOverlay', 'l2_storePlan', 'l2_deletePlan', 'l2_storeFormulary', 'l2_registerEmployer', 'l2_revokeEmployerAttestation', 'l2_registerEmployerNode', 'l2_deregisterEmployerNode']) {
      expect(roleMayCall('insurer', { kind: 'rpc', method: m })).toBe(true);
    }
    for (const m of ['l2_gossipRelay', 'l2_recordFill', 'l2_approveAdmission', 'l2_registerEntity']) {
      expect(roleMayCall('insurer', { kind: 'rpc', method: m })).toBe(false);
    }
    for (const p of ['approve-prior-auth', 'deny-prior-auth', 'terminate-member', 'terminate-group', 'update-formulary', 'plan-year-rollover', 'approve-member']) {
      expect(roleMayCall('insurer', { kind: 'route', method: 'POST', path: `/interactive/${p}` })).toBe(true);
      expect(roleMayCall('insurer', { kind: 'route', method: 'GET', path: `/interactive/${p}` })).toBe(false);
    }
    for (const p of ['decrypt-thread', 'create-delegation', 'reset', 'force-batch', 'save-checkpoint', 'generate-credential']) {
      expect(roleMayCall('insurer', { kind: 'route', method: 'POST', path: `/interactive/${p}` })).toBe(false);
    }
  });

  test('member, prescriber and pharmacy may register their keys and nothing else; the replica relays gossip and pulls a snapshot; the sequencer relays gossip only; the employer nothing', () => {
    for (const role of ['member', 'prescriber', 'pharmacy'] as const) {
      expect(roleMayCall(role, { kind: 'rpc', method: 'l2_registerEntity' })).toBe(true);
      expect(RPC_METHODS_BY_ROLE[role].size).toBe(1);
      expect(ROUTES_BY_ROLE[role].size).toBe(0);
    }
    expect(roleMayCall('replica', { kind: 'rpc', method: 'l2_gossipRelay' })).toBe(true);
    expect(roleMayCall('replica', { kind: 'rpc', method: 'l2_requestSnapshot' })).toBe(true);
    expect(RPC_METHODS_BY_ROLE.replica.size).toBe(2);
    // A13: the leader is a principal on its replicas' servers, for gossip and nothing else
    expect(roleMayCall('sequencer', { kind: 'rpc', method: 'l2_gossipRelay' })).toBe(true);
    expect(roleMayCall('sequencer', { kind: 'rpc', method: 'l2_requestSnapshot' })).toBe(false);
    expect(RPC_METHODS_BY_ROLE.sequencer.size).toBe(1);
    expect(ROUTES_BY_ROLE.sequencer.size).toBe(0);
    expect(RPC_METHODS_BY_ROLE.employer.size).toBe(0);
    expect(ROUTES_BY_ROLE.employer.size).toBe(0);
  });

  test('isNodeRole accepts the eight roles and nothing else', () => {
    for (const r of NODE_ROLES) expect(isNodeRole(r)).toBe(true);
    expect(isNodeRole('admin')).toBe(false);
    expect(isNodeRole('')).toBe(false);
    expect(isNodeRole(undefined)).toBe(false);
  });
});

describe('a node\'s own admin token', () => {
  test('is deterministic for the operator, different per node, and 32 bytes of hex', () => {
    const a = deriveNodeAdminToken('operator-secret', 'insurer');
    expect(a).toBe(deriveNodeAdminToken('operator-secret', 'insurer'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveNodeAdminToken('operator-secret', 'member')).not.toBe(a);
    expect(deriveNodeAdminToken('another-secret', 'insurer')).not.toBe(a);
  });

  test('refuses an empty operator token or an unusable node id', () => {
    expect(() => deriveNodeAdminToken('', 'insurer')).toThrow();
    expect(() => deriveNodeAdminToken('x', '')).toThrow();
    expect(() => deriveNodeAdminToken('x', 'a\nb')).toThrow();
  });
});

describe('node keys', () => {
  test('a generated key signs requests the signed-request verifier accepts under its public half', () => {
    const key = generateNodeKey('member');
    expect(key.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyHexFromSeed(key.seedHex)).toBe(key.publicKeyHex);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params: { walletId: '1' } });
    const headers = signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });
    expect(signerIdFromHeaders(headers)).toBe('member');
    const ok = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: 'member', publicKeyHex: key.publicKeyHex, body });
    expect(ok.ok).toBe(true);
    const tampered = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: 'member', publicKeyHex: key.publicKeyHex, body: body + ' ' });
    expect(tampered.ok).toBe(false);
  });

  test('two keys never coincide and the id may not carry the header separator', () => {
    expect(generateNodeKey('a').seedHex).not.toBe(generateNodeKey('a').seedHex);
    expect(() => generateNodeKey('a:b')).toThrow();
    expect(() => generateNodeKey('')).toThrow();
  });

  test('the public key derivation matches Node\'s own', () => {
    const key = generateNodeKey('x', () => Buffer.alloc(32, 7));
    const pub = createPublicKey(privateKeyFromSeedHex(key.seedHex)).export({ type: 'spki', format: 'der' });
    expect(pub.subarray(pub.length - 32).toString('hex')).toBe(key.publicKeyHex);
    expect(ed25519Verify(null, Buffer.from('m'), createPublicKey(privateKeyFromSeedHex(key.seedHex)), Buffer.alloc(64))).toBe(false);
  });

  test('nodeKeyFromEnv reads the pair, refuses a malformed seed, and is null when absent', () => {
    expect(nodeKeyFromEnv({})).toBeNull();
    expect(nodeKeyFromEnv({ [NODE_ID_ENV]: 'member' })).toBeNull();
    const seed = 'ab'.repeat(32);
    expect(nodeKeyFromEnv({ [NODE_ID_ENV]: 'member', [NODE_KEY_SEED_ENV]: seed })).toEqual({ nodeId: 'member', seedHex: seed });
    expect(() => nodeKeyFromEnv({ [NODE_ID_ENV]: 'member', [NODE_KEY_SEED_ENV]: 'short' })).toThrow();
    expect(() => nodeKeyFromEnv({ [NODE_ID_ENV]: 'a:b', [NODE_KEY_SEED_ENV]: seed })).toThrow();
  });
});

describe('a child\'s environment', () => {
  test('carries none of the parent\'s secrets and exactly what it is given', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/bin', ZKTRIDENT_ADMIN_TOKEN: 'op', ZKTRIDENT_GOSSIP_SECRET: 'g', ZKTRIDENT_INSURER_SIGNING_SEED: 's', ZKTRIDENT_MEMBER_PIN: '1234', ZKTRIDENT_NODE_KEY_SEED: 'parent-seed', ZKTRIDENT_FORMULARY_LIMIT: '100', EMPTY: undefined };
    const env = childEnvironment(base, { ZKTRIDENT_NODE_ID: 'member', ZKTRIDENT_NODE_KEY_SEED: 'child-seed', ZKTRIDENT_PIN: '1234', SKIPPED: undefined });
    expect(env.PATH).toBe('/bin');
    expect(env.ZKTRIDENT_FORMULARY_LIMIT).toBe('100');
    for (const k of SECRET_ENV_KEYS) {
      if (k === 'ZKTRIDENT_NODE_KEY_SEED' || k === 'ZKTRIDENT_PIN') continue;
      expect(env).not.toHaveProperty(k);
    }
    expect(env.ZKTRIDENT_NODE_KEY_SEED).toBe('child-seed');
    expect(env.ZKTRIDENT_PIN).toBe('1234');
    expect(env.ZKTRIDENT_NODE_ID).toBe('member');
    expect(env).not.toHaveProperty('EMPTY');
    expect(env).not.toHaveProperty('SKIPPED');
  });

  test('the secret list names every credential the launcher knows', () => {
    for (const k of ['ZKTRIDENT_ADMIN_TOKEN', 'ZKTRIDENT_INSURER_ADMIN_TOKEN', 'ZKTRIDENT_GOSSIP_SECRET', 'ZKTRIDENT_INSURER_SIGNING_SEED', 'ZKTRIDENT_GENESIS_ADMIN_KEY', 'ZKTRIDENT_NODE_KEY_SEED', 'ZKTRIDENT_PIN', 'ZKTRIDENT_MEMBER_PIN']) {
      expect(SECRET_ENV_KEYS).toContain(k);
    }
  });
});
