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
 * The replicas have credentials — plan item A13, finding A-8.
 *
 * A leader and a replica, each a real L2Node with a real L2RpcServer and a peer network, wired the
 * way the launcher wires them: the leader's server knows the replica's key under `replica`, the
 * replica's server knows the leader's key under `sequencer`, and each peer network signs its calls
 * with its own key. Gossip then crosses in both directions on signatures; an unsigned relay, the
 * operator's token and a role's foreign method are refused; and the replica pulls a snapshot when
 * it connects. The leader's status carries the invariant monitor's report when one is attached.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED, RPC_FORBIDDEN } from '../src/l2/l2-rpc-server.js';
import { L2PeerNetwork } from '../src/l2/l2-peer-network.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { InvariantMonitor, snapshotOf } from '../src/l2/invariant-monitor.js';
import type { GossipMessage } from '../src/l2/l2-peer-types.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-bearer-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const leaderKey = generateNodeKey('sequencer');
const replicaKey = generateNodeKey('replica-1');
const strangerKey = generateNodeKey('stranger');

interface Side { node: L2Node; server: L2RpcServer; peerNet: L2PeerNetwork; url: string; seen: GossipMessage[] }
let leader: Side;
let replica: Side;

async function makeSide(role: 'sequencer' | 'replica', key: { nodeId: string; seedHex: string }, withOperator: boolean): Promise<Side> {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: key.nodeId, role }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  const server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', enableSSE: false, ...(withOperator ? { adminToken: OPERATOR } : {}) });
  const peerNet = new L2PeerNetwork({ nodeId: key.nodeId, role, gossipRelayEnabled: true, announceIntervalMs: 999_999, syncOnConnect: false, nodeKey: key });
  const seen: GossipMessage[] = [];
  peerNet.on((m) => { seen.push(m); });
  server.setPeerNetwork(peerNet);
  await server.start();
  return { node, server, peerNet, url: `http://127.0.0.1:${server.getPort()}`, seen };
}

interface RpcReply { status: number; error?: { code: number; message: string }; result?: any }
async function rpcWith(url: string, headers: Record<string, string>, body: string): Promise<RpcReply> {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, error: parsed?.error, result: parsed?.result };
}
const envelope = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const byKey = (key: { nodeId: string; seedHex: string }, body: string) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const announce = (from: string) => ({ message: { messageId: `${from}-${Date.now()}-${Math.random()}`, type: 'peer:announce', senderId: from, timestamp: Date.now(), payload: { peerId: from, url: '', role: 'replica' } } });

beforeAll(async () => {
  leader = await makeSide('sequencer', leaderKey, true);
  replica = await makeSide('replica', replicaKey, false);
  // the way the launcher registers them: replicas on the leader, the leader (and siblings) on each replica
  leader.server.registerNodeKey(replicaKey.nodeId, replicaKey.publicKeyHex, 'replica', 'in-process replica');
  replica.server.registerNodeKey(leaderKey.nodeId, leaderKey.publicKeyHex, 'sequencer', 'the leader');
});

afterAll(async () => {
  leader.peerNet.stop();
  replica.peerNet.stop();
  await leader.server.stop();
  await replica.server.stop();
});

describe('the replica\'s server', () => {
  test('refuses an unsigned relay, the operator\'s token and a stranger\'s key; accepts the leader\'s signature', async () => {
    const body = envelope('l2_gossipRelay', announce('probe'));
    expect((await rpcWith(replica.url, {}, body)).error?.code).toBe(RPC_UNAUTHORIZED);
    const asOperator = await rpcWith(replica.url, bearer, body);
    expect(asOperator.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(asOperator.error?.message).toMatch(/no admin token configured/);
    expect((await rpcWith(replica.url, byKey(strangerKey, body), body)).error?.code).toBe(RPC_UNAUTHORIZED);
    const fromLeader = await rpcWith(replica.url, byKey(leaderKey, body), body);
    expect(fromLeader.error).toBeUndefined();
    expect(fromLeader.result).toEqual({ accepted: true });
  });

  test('the leader\'s key opens gossip only: an operator method is 403', async () => {
    const body = envelope('l2_forceBatch');
    expect((await rpcWith(replica.url, byKey(leaderKey, body), body)).error?.code).toBe(RPC_FORBIDDEN);
  });
});

describe('the leader\'s server', () => {
  test('accepts the replica\'s gossip and its snapshot request; refuses the replica an operator method', async () => {
    const relay = envelope('l2_gossipRelay', announce(replicaKey.nodeId));
    const relayed = await rpcWith(leader.url, byKey(replicaKey, relay), relay);
    expect(relayed.error).toBeUndefined();
    expect(relayed.result).toEqual({ accepted: true });
    const snapshot = envelope('l2_requestSnapshot');
    const snap = await rpcWith(leader.url, byKey(replicaKey, snapshot), snapshot);
    expect(snap.error).toBeUndefined();
    expect(snap.result).toBeTruthy();
    const batch = envelope('l2_forceBatch');
    expect((await rpcWith(leader.url, byKey(replicaKey, batch), batch)).error?.code).toBe(RPC_FORBIDDEN);
    expect((await rpcWith(leader.url, {}, relay)).error?.code).toBe(RPC_UNAUTHORIZED);
  });
});

describe('gossip over the peer network', () => {
  test('the leader\'s broadcast reaches the replica, signed with the leader\'s key', async () => {
    await leader.peerNet.connectToPeer(replica.url);
    expect(leader.peerNet.getConnectedPeers().length).toBe(1);
    const before = replica.seen.length;
    const message = { messageId: `b-${Date.now()}`, type: 'peer:announce', senderId: leaderKey.nodeId, timestamp: Date.now(), payload: { peerId: leaderKey.nodeId, url: leader.url, role: 'sequencer' } } as unknown as GossipMessage;
    await leader.peerNet.broadcast(message);
    expect(replica.seen.length).toBe(before + 1);
    expect(replica.seen[replica.seen.length - 1].messageId).toBe(message.messageId);
  });

  test('a peer network without a key cannot deliver to a keyed replica', async () => {
    const keyless = new L2PeerNetwork({ nodeId: 'keyless', role: 'sequencer', gossipRelayEnabled: true, announceIntervalMs: 999_999, syncOnConnect: false });
    try {
      await keyless.connectToPeer(replica.url);
      const before = replica.seen.length;
      await keyless.broadcast({ messageId: `k-${Date.now()}`, type: 'peer:announce', senderId: 'keyless', timestamp: Date.now(), payload: {} } as unknown as GossipMessage);
      expect(replica.seen.length).toBe(before);
    } finally {
      keyless.stop();
    }
  });
});

describe('the invariant monitor on the leader\'s status', () => {
  test('l2_getStatus carries the report when a monitor is attached', async () => {
    const monitor = new InvariantMonitor({
      leader: () => snapshotOf(leader.node.getStatus(), leaderKey.nodeId),
      replicas: () => [snapshotOf(replica.node.getStatus(), replicaKey.nodeId)],
      log: () => {},
    });
    leader.server.setInvariantMonitor(monitor);
    const status = await rpcWith(leader.url, {}, envelope('l2_getStatus'));
    expect(status.result?.invariants).toMatchObject({ ok: true, replicas: [{ nodeId: replicaKey.nodeId, inSync: true }], batch: { stalled: false } });
    leader.server.setInvariantMonitor(null);
    expect((await rpcWith(leader.url, {}, envelope('l2_getStatus'))).result?.invariants).toBeUndefined();
  });
});
