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
 * Node roles and per-node credentials — plan item A9 (remainder), finding A-14.
 *
 * One credential per principal. The network operator keeps a bearer token that only the sequencer
 * accepts. Every node process the launcher starts gets an Ed25519 key of its own, generated at boot
 * and never written to disk, whose public half the launcher registers on the sequencer with a role.
 * The sequencer authorises a signed request by that role, from the tables below: a node's
 * compromise yields that node's role, not the network. A node's own admin routes authenticate the
 * people and tools that operate that node, with that node's own token, which for the insurer is
 * derived from the operator's token in a way the insurer cannot reverse.
 *
 * The tables are the single source of truth for what each role may do. A method or route that is
 * not listed for a role is refused with 403 even when the signature is valid; the operator's keys
 * and bearer are not consulted here because the operator may do everything.
 */
import { createHmac, createPublicKey, randomBytes } from 'crypto';
import { privateKeyFromSeedHex } from './signed-request.js';

export type NodeRole = 'operator' | 'insurer' | 'member' | 'prescriber' | 'pharmacy' | 'replica' | 'sequencer' | 'employer';

export const NODE_ROLES: readonly NodeRole[] = ['operator', 'insurer', 'member', 'prescriber', 'pharmacy', 'replica', 'sequencer', 'employer'];

export function isNodeRole(value: unknown): value is NodeRole {
  return typeof value === 'string' && (NODE_ROLES as readonly string[]).includes(value);
}

/** The admin RPC methods each non-operator role may call. */
export const RPC_METHODS_BY_ROLE: Readonly<Record<Exclude<NodeRole, 'operator'>, ReadonlySet<string>>> = {
  insurer: new Set([
    'l2_credentialProvider',
    'l2_updateProviderStatus',
    'l2_publishPlanOverlay',
    'l2_storePlan',
    'l2_deletePlan',
    'l2_storeFormulary',
    'l2_registerEmployer',
    'l2_revokeEmployerAttestation',
    'l2_registerEmployerNode',
    'l2_deregisterEmployerNode',
  ]),
  member: new Set(['l2_registerEntity']),
  prescriber: new Set(['l2_registerEntity']),
  pharmacy: new Set(['l2_registerEntity']),
  // A13: a replica relays gossip to the leader and pulls a snapshot from it when it connects; the
  // leader, as a principal on its replicas' servers, pushes gossip and nothing else.
  replica: new Set(['l2_gossipRelay', 'l2_requestSnapshot']),
  sequencer: new Set(['l2_gossipRelay']),
  employer: new Set<string>(),
};

/** The admin-gated HTTP routes (`METHOD:path`) each non-operator role may call. */
export const ROUTES_BY_ROLE: Readonly<Record<Exclude<NodeRole, 'operator'>, ReadonlySet<string>>> = {
  insurer: new Set([
    'GET:/viz/entities',
    'GET:/viz/state',
    'GET:/viz/history',
    'GET:/events',
    'GET:/viz/events',
    'GET:/interactive/member-history',
    'GET:/interactive/family-history',
    'GET:/interactive/threads',
    'GET:/interactive/prescriptions-by-pharmacy',
    'GET:/interactive/fill-status',
    'GET:/interactive/step-therapy-check',
    'POST:/interactive/approve-prior-auth',
    'POST:/interactive/deny-prior-auth',
    'POST:/interactive/terminate-member',
    'POST:/interactive/terminate-group',
    'POST:/interactive/update-formulary',
    'POST:/interactive/plan-year-rollover',
    'POST:/interactive/approve-member',
  ]),
  // D2: a node subscribes to the event stream and calls the engine routes its work needs. The employer
  // has neither: the stream names wallets, which an employer never learns (I6).
  member: new Set(['GET:/events']),
  prescriber: new Set([
    'GET:/events',
    'POST:/interactive/prescribe',
    'POST:/interactive/resolve-indices',
    'POST:/interactive/request-prior-auth',
    'GET:/interactive/step-therapy-check',
  ]),
  pharmacy: new Set([
    'GET:/events',
    'POST:/interactive/fill',
    'POST:/interactive/mark-filled',
    'POST:/interactive/prescribe-and-fill',
    'POST:/interactive/update-rx-status',
    'POST:/interactive/reverse',
    'POST:/interactive/resolve-indices',
    'GET:/interactive/fill-status',
    'GET:/interactive/prescriptions-by-pharmacy',
  ]),
  replica: new Set<string>(),
  sequencer: new Set<string>(),
  employer: new Set<string>(),
};

export type AuthScope =
  | { kind: 'rpc'; method: string }
  | { kind: 'route'; method: string; path: string };

/** Whether a role may perform the scoped action. The operator may do everything. */
export function roleMayCall(role: NodeRole, scope: AuthScope): boolean {
  if (role === 'operator') return true;
  if (scope.kind === 'rpc') return RPC_METHODS_BY_ROLE[role].has(scope.method);
  return ROUTES_BY_ROLE[role].has(`${scope.method.toUpperCase()}:${scope.path}`);
}

// ─── Per-node admin tokens ───────────────────────────────────────────────────────

const NODE_ADMIN_TOKEN_LABEL = 'zpk.care/node-admin/v1\n';

/**
 * A node's own admin token, derived from the operator's. HMAC, so the node cannot recover the
 * operator's token from what it holds, and the operator can recompute the node's token from theirs.
 * An explicitly configured token for the node (for example `ZKTRIDENT_INSURER_ADMIN_TOKEN`) takes
 * precedence over this derivation wherever it is used.
 */
export function deriveNodeAdminToken(operatorToken: string, nodeId: string): string {
  if (!operatorToken) throw new Error('deriveNodeAdminToken: the operator token is empty');
  if (!nodeId || nodeId.includes('\n')) throw new Error('deriveNodeAdminToken: nodeId is required and may not contain a newline');
  return createHmac('sha256', operatorToken).update(NODE_ADMIN_TOKEN_LABEL + nodeId, 'utf8').digest('hex');
}

// ─── Node keys ─────────────────────────────────────────────────────────────────

export interface NodeKey {
  nodeId: string;
  /** 32 bytes of hex: the Ed25519 private seed. Never written to disk. */
  seedHex: string;
  /** 32 bytes of hex: the raw Ed25519 public key. */
  publicKeyHex: string;
}

const ED25519_SPKI_PREFIX_BYTES = 12;

/** The raw public key for a private seed, as 64 hex characters. */
export function publicKeyHexFromSeed(seedHex: string): string {
  const pub = createPublicKey(privateKeyFromSeedHex(seedHex));
  return pub.export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX_BYTES).toString('hex');
}

/** A fresh key for one node process. `rng` is injectable for tests only. */
export function generateNodeKey(nodeId: string, rng: (n: number) => Buffer = randomBytes): NodeKey {
  if (!nodeId || nodeId.includes(':')) throw new Error('generateNodeKey: nodeId is required and may not contain ":"');
  const seedHex = rng(32).toString('hex');
  return { nodeId, seedHex, publicKeyHex: publicKeyHexFromSeed(seedHex) };
}

// ─── Child environments ────────────────────────────────────────────────────────

export const NODE_ID_ENV = 'ZKTRIDENT_NODE_ID';
export const NODE_KEY_SEED_ENV = 'ZKTRIDENT_NODE_KEY_SEED';

/**
 * Environment variables that are secrets. A child process gets none of them from its parent's
 * environment; whatever a child needs is passed to it explicitly, by name.
 */
export const SECRET_ENV_KEYS: readonly string[] = [
  'ZKTRIDENT_ADMIN_TOKEN',
  'ZKTRIDENT_INSURER_ADMIN_TOKEN',
  'ZKTRIDENT_GOSSIP_SECRET',
  'ZKTRIDENT_INSURER_SIGNING_SEED',
  'ZKTRIDENT_GENESIS_ADMIN_KEY',
  'ZKTRIDENT_PIN',
  'ZKTRIDENT_MEMBER_PIN',
  NODE_KEY_SEED_ENV,
];

/** The parent's environment without its secrets, plus exactly what this child is given. */
export function childEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SECRET_ENV_KEYS.includes(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** The node key a child was started with, or null when it was started without one. */
export function nodeKeyFromEnv(env: NodeJS.ProcessEnv): { nodeId: string; seedHex: string } | null {
  const nodeId = env[NODE_ID_ENV];
  const seedHex = env[NODE_KEY_SEED_ENV];
  if (!nodeId || !seedHex) return null;
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error(`${NODE_KEY_SEED_ENV} must be 32 bytes of hex`);
  if (nodeId.includes(':')) throw new Error(`${NODE_ID_ENV} may not contain ":"`);
  return { nodeId, seedHex };
}
