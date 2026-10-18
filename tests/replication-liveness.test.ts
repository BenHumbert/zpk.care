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
 * Replication that survives a busy leader — plan item A13, second half, finding A-8.
 *
 * The first live run with credentials showed four faults the gate had hidden. A replica answered a
 * relay only after relaying onward, which waited on a leader whose event loop was busy proving;
 * the leader's own relay then timed out and one timeout dropped the replica silently and for good;
 * the leader's admin mutations never travelled, so a replica's roots lagged until the next receipt;
 * and a replica never took the leader's state when it connected, so it started at genesis. Each is
 * exercised here with real nodes, servers and peer networks on random ports.
 */
import http from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2PeerNetwork } from '../src/l2/l2-peer-network.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';
import type { GossipMessage } from '../src/l2/l2-peer-types.js';

jest.setTimeout(90_000);

const OPERATOR = 'operator-bearer-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, step = 100): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (cond()) return true; await sleep(step); }
  return cond();
}
const announce = (from: string): GossipMessage => ({ messageId: `${from}-${Date.now()}-${Math.random()}`, type: 'peer:announce', senderId: from, timestamp: Date.now(), payload: { peerId: from, url: '', role: 'replica' } } as unknown as GossipMessage);
const envelope = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const byKey = (key: { nodeId: string; seedHex: string }, body: string) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });

/** A peer that answers l2_getPeerInfo at once and never answers anything else: a busy leader, to a relay. */
function slowPeer(): Promise<{ url: string; close: () => void; held: number }> {
  return new Promise((resolve) => {
    const state = { held: 0 };
    const sockets = new Set<import('net').Socket>();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (body.includes('l2_getPeerInfo')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { peerId: 'slow-peer', url: '', role: 'sequencer', status: 'connected', lastSeen: Date.now(), latestSequenceNumber: '0', latestBatchNumber: null } }));
        } else {
          state.held += 1; // hold the request open; the client gives up after its timeout
        }
      });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => { for (const s of sockets) s.destroy(); server.close(); }, get held() { return state.held; } } as any);
    });
  });
}

describe('a relay is answered before it is relayed onward', () => {
  test('a replica with a slow peer still answers the leader at once', async () => {
    const leaderKey = generateNodeKey('leader-a');
    const replicaKey = generateNodeKey('replica-a');
    const replica = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: replicaKey.nodeId, role: 'replica' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    const server = new L2RpcServer(replica, { port: 0, host: '127.0.0.1', enableSSE: false });
    server.registerNodeKey(leaderKey.nodeId, leaderKey.publicKeyHex, 'sequencer');
    const net = new L2PeerNetwork({ nodeId: replicaKey.nodeId, role: 'replica', gossipRelayEnabled: true, announceIntervalMs: 999_999, syncOnConnect: false, nodeKey: replicaKey });
    server.setPeerNetwork(net);
    await server.start();
    const slow = await slowPeer();
    try {
      await net.connectToPeer(slow.url);
      const body = envelope('l2_gossipRelay', { message: announce('leader-a') });
      const t = Date.now();
      const r = await fetch(`http://127.0.0.1:${server.getPort()}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...byKey(leaderKey, body) }, body });
      const json = await r.json() as any;
      const elapsed = Date.now() - t;
      expect(json.result).toEqual({ accepted: true });
      expect(elapsed).toBeLessThan(3_000);
      // the relay onward did go out, in the background
      expect(await until(() => slow.held >= 1, 3_000)).toBe(true);
    } finally {
      slow.close();
      net.stop();
      await server.stop();
    }
  });
});

describe('a peer survives a failed relay, is given up after three, and comes back', () => {
  test('threshold, one warning, reconnection on demand', async () => {
    const leaderKey = generateNodeKey('leader-b');
    const replicaKey = generateNodeKey('replica-b');
    const replica = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: replicaKey.nodeId, role: 'replica' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    const replicaNet = new L2PeerNetwork({ nodeId: replicaKey.nodeId, role: 'replica', gossipRelayEnabled: false, announceIntervalMs: 999_999, syncOnConnect: false, nodeKey: replicaKey });
    const seen: GossipMessage[] = [];
    replicaNet.on((m) => { seen.push(m); });
    const makeServer = async (port: number) => {
      const s = new L2RpcServer(replica, { port, host: '127.0.0.1', enableSSE: false });
      s.registerNodeKey(leaderKey.nodeId, leaderKey.publicKeyHex, 'sequencer');
      s.setPeerNetwork(replicaNet);
      await s.start();
      return s;
    };
    let server = await makeServer(0);
    const port = server.getPort();
    const leaderNet = new L2PeerNetwork({ nodeId: leaderKey.nodeId, role: 'sequencer', gossipRelayEnabled: true, announceIntervalMs: 999_999, syncOnConnect: false, nodeKey: leaderKey });
    const warnings: string[] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await leaderNet.connectToPeer(`http://127.0.0.1:${port}`);
      expect(leaderNet.getConnectedPeers().map((p) => p.peerId)).toEqual([replicaKey.nodeId]);
      await leaderNet.broadcast(announce('leader-b'));
      expect(await until(() => seen.length === 1, 3_000)).toBe(true);

      await server.stop();
      for (let i = 1; i <= 2; i++) {
        await leaderNet.broadcast(announce('leader-b'));
        expect(leaderNet.getConnectedPeers().length).toBe(1); // tolerated
      }
      await leaderNet.broadcast(announce('leader-b'));
      expect(leaderNet.getConnectedPeers().length).toBe(0); // given up after the third
      expect(warnings.filter((w) => w.includes('unreachable after 3 failed relays'))).toHaveLength(1);
      await leaderNet.broadcast(announce('leader-b'));
      expect(warnings.filter((w) => w.includes('unreachable after'))).toHaveLength(1); // said once

      server = await makeServer(port);
      expect(await leaderNet.reconnectDisconnectedPeers()).toBe(1);
      expect(leaderNet.getConnectedPeers().map((p) => p.peerId)).toEqual([replicaKey.nodeId]);
      const before = seen.length;
      await leaderNet.broadcast(announce('leader-b'));
      expect(await until(() => seen.length === before + 1, 3_000)).toBe(true);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      leaderNet.stop();
      replicaNet.stop();
      await server.stop();
    }
  });
});

describe('a replica follows the leader\'s admin mutations and takes its state on connect', () => {
  const leaderKey = generateNodeKey('leader-c');
  const replicaKey = generateNodeKey('replica-c');
  let leader: L2Node; let leaderServer: L2RpcServer;
  let replica: L2Node; let replicaServer: L2RpcServer;

  afterAll(async () => {
    await replica?.stop();
    await replicaServer?.stop();
    await leader?.stop();
    await leaderServer?.stop();
  });

  test('a replica that connects after the leader has state takes that state, then follows each admin mutation', async () => {
    leader = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: leaderKey.nodeId, role: 'sequencer', nodeKey: leaderKey, maxPeers: 4 }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    leaderServer = new L2RpcServer(leader, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    leaderServer.registerNodeKey(replicaKey.nodeId, replicaKey.publicKeyHex, 'replica');
    await leaderServer.start();
    const leaderUrl = `http://127.0.0.1:${leaderServer.getPort()}`;
    // state before any replica exists, the way the engine provisions seed providers at boot
    leader.getSequencer().adminMutate('seed providers', ({ provision }) => { provision(Field(501n), LIFECYCLE_ELIGIBLE); provision(Field(502n), LIFECYCLE_ELIGIBLE); });
    leader.start();
    expect(leader.getStatus().currentRegistryRoot).not.toBe(emptyRoot.toString());

    replica = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: replicaKey.nodeId, role: 'replica', nodeKey: replicaKey, seedPeers: [leaderUrl] }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    replicaServer = new L2RpcServer(replica, { port: 0, host: '127.0.0.1', enableSSE: false });
    replicaServer.registerNodeKey(leaderKey.nodeId, leaderKey.publicKeyHex, 'sequencer');
    await replicaServer.start();
    replica.start();
    expect(await until(() => replica.getPeerNetwork() !== null, 5_000)).toBe(true);
    replicaServer.setPeerNetwork(replica.getPeerNetwork()!);
    // the snapshot taken on connect
    expect(await until(() => replica.getStatus().currentRegistryRoot === leader.getStatus().currentRegistryRoot, 10_000)).toBe(true);
    expect(replica.getStatus().currentLifecycleRoot).toBe(leader.getStatus().currentLifecycleRoot);
    expect(replica.getStatus().currentWalletCount).toBe('2');

    // the leader learns about the replica (as the launcher connects it) and gossips its next admin mutation
    const leaderNet = await leader.ensurePeerNetwork();
    leaderServer.setPeerNetwork(leaderNet);
    await leaderNet.connectToPeer(`http://127.0.0.1:${replicaServer.getPort()}`);
    leader.getSequencer().adminMutate('a member becomes eligible', ({ provision }) => { provision(Field(503n), LIFECYCLE_ELIGIBLE); });
    expect(await until(() => replica.getStatus().currentRegistryRoot === leader.getStatus().currentRegistryRoot, 10_000)).toBe(true);
    expect(replica.getStatus().currentWalletCount).toBe('3');
  });

  test('a sequencer ignores roots gossip; only replicas apply it', async () => {
    const other = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'other-seq', role: 'sequencer' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    const before = other.getStatus().currentRegistryRoot;
    await (other as any).handleGossip({ messageId: 'x', type: 'state:roots', senderId: 'someone', timestamp: Date.now(), payload: { reason: 'r', registryRoot: '123', lifecycleRoot: '456', walletCount: '7' } });
    expect(other.getStatus().currentRegistryRoot).toBe(before);
    await (replica as any).handleGossip({ messageId: 'y', type: 'state:roots', senderId: 'someone', timestamp: Date.now(), payload: { reason: 'r', registryRoot: '123', lifecycleRoot: '456', walletCount: '7' } });
    expect(replica.getStatus().currentRegistryRoot).toBe('123');
  });
});
