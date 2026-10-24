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
 * Every node's event stream answers only that node's own credential — finding A-79.
 *
 * What was wrong: GET /events on every Nautilus node re-served the sequencer's event stream, which names the wallet of
 * every proof it accepts, with no credential at all, and kept a 128-event replay buffer for anyone who asked. The
 * sequencer's own stream has been gated since D2; the relay in front of it was not. Once the insurer node serves the
 * marketplace to employers, any employer's browser on that origin could read the wallet stream, which I6 forbids, and
 * on any node a page rebound to loopback could. Found by the security posture check of 2026-10-24
 * (nautilus-app-server.ts handleSSE).
 *
 * Now the stream answers the device's session on a member node and this node's admin credential on any node. A
 * browser's EventSource cannot send a header, so a page trades its credential for a single-use, 30-second ticket
 * (POST /events/ticket) and opens /events?ticket=...; a stream the device's session opened ends with the session. A
 * member node forwards only the events that name no wallet or its own; an insurer node, whose origin also serves the
 * marketplace, forwards no event that names a wallet. The member, employer, insurer and prescriber pages connect with
 * the credential each holds in memory, and the pharmacy page, which holds none until provider sign-in (B4), opens no
 * stream.
 *
 * A first cut also counted every run of 30 or more digits in an event's free text as a wallet the event named, since a
 * rejection reason may quote one ("Wallet already registered: <wallet ID>"). An independent review found that this hid
 * events the pages need: the sequencer's reasons quote roots too ("Registry root mismatch: proof expects <root> but L2
 * state is <root>", the routine rejection when enrollments race), so the insurer's event log lost them, and so did a
 * member's stream, since a root is never the member's wallet; an employer event whose ID held a long run of digits went
 * the same way. The review also found wallet fields the check missed: a list of IDs under a walletIds key, and a wallet
 * nested below the four levels it read. Now free text decides nothing. On a member or insurer node each run of 30 or
 * more digits inside free text, a string with any non-digit in it, is cut to an ellipsis in the copy the stream sends,
 * live or replayed, so neither a quoted wallet nor a quoted root reaches the page and the event still arrives; a field
 * of digits alone, a root or a hash, is kept. Whether an event goes out is decided by its wallet fields, one ID or a
 * list, read eight levels down, and an event nested deeper does not go out. A prescriber's, pharmacy's or employer's
 * stream, which only that node's administrator reads, is unchanged.
 *
 * The review of the per-caller limits found in the stream's head the fault the explorer's relay had had (A-83): it named
 * "Connection: keep-alive" itself, which overrode a client's "Connection: close", so when a stream ended (the device's
 * session ending the streams it opened, say) the node held the client's socket open for Node's keep-alive timeout,
 * about 6 s, though HTTP/1.1 has a server close the connection once it has answered a request that asked it to. The
 * head now names no connection option and Node chooses: a client that asked to close is told the connection will
 * close, and it closes as the stream ends; a client that keeps its connection still gets its stream, and sends its next
 * request on the same connection once the stream ends.
 *
 * The servers are real NautilusAppServers on loopback with a stand-in entity node that emits chain events; the pages'
 * rpc.js files run against them with Node's fetch and a small EventSource over http.get. A review of these tests found
 * that the member test could fail by chance: it searched a stream's body for a four-digit wallet ID, which a 13-digit
 * timestamp holds about once in a thousand frames. The wallet IDs are now runs of digits no other field can hold.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import type { EntityNodeBase } from '../src/nodes/entity-node-base.js';
import type { L2ChainEvent } from '../src/l2/l2-node.js';

jest.setTimeout(60_000);

const TOKEN = 'node-own-admin-token-for-tests';
/**
 * Two wallet IDs, each a run of 20 digits, since a stream's body is searched for them as text: longer than the 13-digit
 * timestamp and the counters an event carries, so no other field holds one by chance, and shorter than the 30 digits a
 * narrowed stream cuts from free text, so a body without one has not merely had it cut.
 */
const OWN_WALLET = '1'.repeat(20);
const OTHER_WALLET = '2'.repeat(20);
const servers: NautilusAppServer[] = [];
const dirs: string[] = [];
const streams: Stream[] = [];

/** A node for `role` on loopback, with SSE on and a stand-in entity node whose events the test emits. */
async function startNode(role: string): Promise<{ server: NautilusAppServer; url: string; emit: (e: L2ChainEvent) => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-events-'));
  dirs.push(dir);
  const server = new NautilusAppServer({
    role, port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
    enableSSE: true, maxSseConnections: 10, allowedOrigins: [], adminToken: TOKEN,
  } as unknown as NautilusAppConfig);
  let handler: ((e: L2ChainEvent) => void) | null = null;
  const node = {
    setWalletSignerSource: () => undefined,
    connectEvents: (h: (e: L2ChainEvent) => void) => { handler = h; return () => { handler = null; }; },
    getWalletId: () => (role === 'member' ? OWN_WALLET : undefined),
  };
  server.setEntityNode(node as unknown as EntityNodeBase);
  await server.start();
  servers.push(server);
  return { server, url: `http://127.0.0.1:${server.getPort()}`, emit: (e) => handler?.(e) };
}

interface Stream { status: number; events: any[]; body: string; ended: boolean; close(): void }

/** GET a stream; resolves when the answer's head arrives, and collects each `data:` frame after that. */
function open(url: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      const stream: Stream = { status: res.statusCode ?? 0, events: [], body: '', ended: false, close: () => req.destroy() };
      streams.push(stream);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        stream.body += chunk;
        buf += chunk;
        for (let at = buf.indexOf('\n\n'); at >= 0; at = buf.indexOf('\n\n')) {
          const line = buf.slice(0, at).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(at + 2);
          if (line) stream.events.push(JSON.parse(line.slice(5).trim()));
        }
      });
      res.on('end', () => { stream.ended = true; });
      res.on('error', () => { stream.ended = true; });
      resolve(stream);
    });
    req.on('error', reject);
  });
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function ticketFor(url: string, headers: Record<string, string>): Promise<{ status: number; ticket?: string }> {
  const r = await fetch(url + '/events/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } });
  const json = await r.json() as { data?: { ticket?: string } };
  return { status: r.status, ticket: json.data?.ticket };
}

const bearer = { Authorization: `Bearer ${TOKEN}` };
const event = (type: string, data: Record<string, unknown>): L2ChainEvent => ({ type, timestamp: Date.now(), data } as unknown as L2ChainEvent);

/** A member or insurer node with a stream open under the credential its page holds, read past the connected frame. */
async function narrowedStream(role: string): Promise<{ url: string; s: Stream; emit: (e: L2ChainEvent) => void }> {
  const { server, url, emit } = await startNode(role);
  const s = await open(url + '/events', role === 'member' ? { 'X-Device-Session': server.issueDeviceSession().token } : bearer);
  await until(() => s.events.length === 1, 'the connected frame');
  return { url, s, emit };
}

/** Emit `events`, then a walletless batch:empty; once that arrives, so has everything the stream forwards of them. */
async function forwarded(s: Stream, emit: (e: L2ChainEvent) => void, events: L2ChainEvent[]): Promise<any[]> {
  const from = s.events.length;
  for (const e of events) emit(e);
  emit(event('batch:empty', {}));
  await until(() => s.events.slice(from).some((e) => e.type === 'batch:empty'), 'the closing batch:empty');
  return s.events.slice(from).filter((e) => e.type !== 'batch:empty');
}

/** Fields to spread into an event's data that put `inner` `levels` objects below the data itself. */
const buried = (levels: number, inner: Record<string, unknown>): Record<string, unknown> =>
  levels === 0 ? inner : { deeper: buried(levels - 1, inner) };

/** A wallet ID as the network writes one, and two roots: 76 and 77 digits. */
const QUOTED = '9876543210987654321098765432109876543210987654321098765432109876543210987654';
const OLD_ROOT = '14781298372635401928374650192837465019283746501928374650192837465019283746501';
const L2_ROOT = '21543078621478965230147896523014789652301478965230147896523014789652301478965';

afterAll(async () => {
  for (const s of streams) s.close();
  for (const server of servers) await server.stop();
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('a node\'s /events refuses a caller without this node\'s credential', () => {
  test.each(['member', 'prescriber', 'pharmacy', 'insurer', 'employer'])('%s node: no credential, a wrong one or a made-up ticket is 401', async (role) => {
    const { url } = await startNode(role);
    expect((await open(url + '/events')).status).toBe(401);                       // before: 200, the wallet stream
    expect((await open(url + '/events', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await open(url + '/events', { 'X-Device-Session': 'not-a-session' })).status).toBe(401);
    expect((await open(url + '/events?ticket=made-up')).status).toBe(401);
    expect((await ticketFor(url, {})).status).toBe(401);
  });

  test('the refusal names what to present: the device\'s PIN on a member node, the administrator elsewhere', async () => {
    const member = await startNode('member');
    const insurer = await startNode('insurer');
    const a = await open(member.url + '/events');
    const b = await open(insurer.url + '/events');
    await until(() => a.ended && b.ended, 'both refusals');
    expect(JSON.parse(a.body).error).toMatch(/locked|PIN/);
    expect(JSON.parse(b.body).error).toMatch(/administrator/);
  });
});

describe('with the credential the stream opens', () => {
  test('a header credential opens it directly: the node\'s admin bearer', async () => {
    const { url } = await startNode('prescriber');
    const s = await open(url + '/events', bearer);
    expect(s.status).toBe(200);
    await until(() => s.events.length > 0, 'the connected frame');
    expect(s.events[0]).toMatchObject({ type: 'connected', role: 'prescriber' });
  });

  test('a browser\'s way in: the credential buys a ticket, and the ticket opens one stream within 30 s', async () => {
    const { url } = await startNode('insurer');
    const t = await ticketFor(url, bearer);
    expect(t.status).toBe(200);
    expect(t.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const s = await open(`${url}/events?ticket=${encodeURIComponent(t.ticket!)}`);
    expect(s.status).toBe(200);
    expect((await open(`${url}/events?ticket=${encodeURIComponent(t.ticket!)}`)).status).toBe(401);   // single use

    const late = await ticketFor(url, bearer);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    try {
      expect((await open(`${url}/events?ticket=${encodeURIComponent(late.ticket!)}`)).status).toBe(401);   // expired
    } finally {
      clock.mockRestore();
    }
  });

  test('on a member node the device\'s session opens it, as a header or through a ticket, and so does the admin', async () => {
    const { server, url } = await startNode('member');
    const session = server.issueDeviceSession().token;
    expect((await open(url + '/events', { 'X-Device-Session': session })).status).toBe(200);
    const t = await ticketFor(url, { 'X-Device-Session': session });
    expect(t.status).toBe(200);
    expect((await open(`${url}/events?ticket=${encodeURIComponent(t.ticket!)}`)).status).toBe(200);
    expect((await open(url + '/events', bearer)).status).toBe(200);
  });

  test('a stream the device\'s session opened ends when the device locks, and an unused ticket from that session opens nothing', async () => {
    const { server, url } = await startNode('member');
    const session = server.issueDeviceSession().token;
    const s = await open(url + '/events', { 'X-Device-Session': session });
    const unused = await ticketFor(url, { 'X-Device-Session': session });
    const admin = await open(url + '/events', bearer);
    expect(s.status).toBe(200);
    server.clearDeviceSession();
    await until(() => s.ended, 'the device stream to end');
    expect((await open(`${url}/events?ticket=${encodeURIComponent(unused.ticket!)}`)).status).toBe(401);
    expect(admin.ended).toBe(false);                                              // the administrator's stream is not the session's

    const renewed = server.issueDeviceSession().token;
    const again = await open(url + '/events', { 'X-Device-Session': renewed });
    server.issueDeviceSession();                                                 // unlocking again replaces the session
    await until(() => again.ended, 'the replaced session\'s stream to end');
  });
});

describe('what a stream carries', () => {
  test('a member node forwards the events that name no wallet or its own wallet, and never another member\'s', async () => {
    const { server, url, emit } = await startNode('member');
    const s = await open(url + '/events', { 'X-Device-Session': server.issueDeviceSession().token });
    await until(() => s.events.length === 1, 'the connected frame');
    emit(event('proof:accepted', { receiptId: 'r-other', walletId: OTHER_WALLET }));
    emit(event('audit:event', { type: 'messaging', senderWalletId: OTHER_WALLET }));
    emit(event('proof:accepted', { receiptId: 'r-own', walletId: OWN_WALLET }));
    emit(event('batch:settled', { batchId: '7' }));
    await until(() => s.events.length === 3, 'two forwarded events');
    expect(s.events.slice(1).map((e) => e.type)).toEqual(['proof:accepted', 'batch:settled']);
    expect(s.events[1].data.walletId).toBe(OWN_WALLET);
    expect(s.body).not.toContain(OTHER_WALLET);

    // The replay buffer answers the same way.
    const replay = await open(url + '/events?lastEventId=0', bearer);
    await until(() => replay.events.length === 3, 'the replay');
    expect(replay.body).not.toContain(OTHER_WALLET);
  });

  test('a wallet quoted in an event\'s free text is cut out: the rejection reaches a member and the insurer without it', async () => {
    const reason = `Wallet already registered: ${QUOTED}`;            // the sequencer's own wording (l2-sequencer-service.ts)
    const ROOT = '24788165130318436427406127548399402722383373227706040567117858806745727393584';
    const rejection = event('proof:rejected', { reason });
    for (const role of ['member', 'insurer']) {
      const { url, s, emit } = await narrowedStream(role);
      const got = await forwarded(s, emit, [
        rejection,
        event('proof:rejected', { reason: 'Proof failed verification' }),
        event('batch:settled', { batchId: '9', newRegistryRoot: ROOT }),
      ]);
      expect([role, got.map((e) => e.data.reason ?? e.type)]).toEqual(
        [role, ['Wallet already registered: …', 'Proof failed verification', 'batch:settled']]);   // before: the first rejection was dropped
      expect([role, got.find((e) => e.type === 'batch:settled').data.newRegistryRoot]).toEqual([role, ROOT]);   // digits alone are kept
      expect([role, s.body.includes(QUOTED)]).toEqual([role, false]);

      // A replay sends its own copy, cut the same way.
      const replay = await open(url + '/events?lastEventId=0', bearer);
      await until(() => replay.events.some((e) => e.type === 'batch:empty'), 'the replay');
      expect([role, replay.events.filter((e) => e.type === 'proof:rejected').map((e) => e.data.reason)]).toEqual(
        [role, ['Wallet already registered: …', 'Proof failed verification']]);       // before: the first rejection was dropped
      expect([role, replay.body.includes(QUOTED)]).toEqual([role, false]);
    }
    expect(rejection.data.reason).toBe(reason);                                     // the event the replay buffer keeps is as it came
  });

  test('a rejection that quotes roots reaches a member and the insurer with the roots cut out: a root mismatch is routine when enrollments race', async () => {
    const mismatch = `Registry root mismatch: proof expects ${OLD_ROOT} but L2 state is ${L2_ROOT}`;   // l2-sequencer-service.ts
    const divergence = `Wallet state divergence before applying a proof: registry tree ${L2_ROOT} vs root ${OLD_ROOT}, ` +
      `lifecycle tree ${OLD_ROOT} vs root ${L2_ROOT}`;
    for (const role of ['member', 'insurer']) {
      const { s, emit } = await narrowedStream(role);
      const got = await forwarded(s, emit, [
        event('proof:rejected', { reason: mismatch }),
        event('proof:rejected', { reason: divergence, partitionIndex: 0 }),
      ]);
      expect([role, got.map((e) => e.data.reason)]).toEqual([role, [
        'Registry root mismatch: proof expects … but L2 state is …',
        'Wallet state divergence before applying a proof: registry tree … vs root …, lifecycle tree … vs root …',
      ]]);                                                                           // before: [], both dropped as naming wallets
      expect([role, s.body.includes(OLD_ROOT) || s.body.includes(L2_ROOT)]).toEqual([role, false]);
    }
  });

  test('an employer event whose ID holds a long run of digits reaches a member and the insurer, with the run cut out', async () => {
    const employerId = 'ACME-' + '0'.repeat(34) + '42';
    for (const role of ['member', 'insurer']) {
      const { s, emit } = await narrowedStream(role);
      const got = await forwarded(s, emit, [event('employer:registered', { employerId, attestationSeq: 3 })]);
      expect([role, got.map((e) => e.data)]).toEqual([role, [{ employerId: 'ACME-…', attestationSeq: 3 }]]);   // before: [], dropped as naming a wallet
    }
  });

  test('a walletIds field names every wallet it lists: a member\'s stream carries a list of its own, and neither stream one with another\'s', async () => {
    for (const role of ['member', 'insurer']) {
      const { s, emit } = await narrowedStream(role);
      const got = await forwarded(s, emit, [
        event('audit:event', { label: 'another', walletIds: [OTHER_WALLET] }),
        event('audit:event', { label: 'own and another', walletIds: [OWN_WALLET, OTHER_WALLET] }),
        event('audit:event', { label: 'another, one ID', memberWalletIds: BigInt(OTHER_WALLET) }),
        event('audit:event', { label: 'own', walletIds: [OWN_WALLET] }),
        event('audit:event', { label: 'none', walletIds: [] }),
      ]);
      expect([role, got.map((e) => e.data.label)]).toEqual([role, role === 'member' ? ['own', 'none'] : ['none']]);   // before: all five, no walletIds field was read
    }
  });

  test('wallet fields are read eight levels down, and an event nested deeper reaches neither a member nor the insurer', async () => {
    for (const role of ['member', 'insurer']) {
      const { s, emit } = await narrowedStream(role);
      const got = await forwarded(s, emit, [
        event('audit:event', { label: 'wallet, 8 down', ...buried(8, { walletId: OTHER_WALLET }) }),
        event('audit:event', { label: 'wallet, 9 down', ...buried(9, { walletId: OTHER_WALLET }) }),
        event('audit:event', { label: 'no wallet, 9 down', ...buried(9, { note: 'nothing here' }) }),
        event('audit:event', { label: 'no wallet, 8 down', ...buried(8, { note: 'nothing here' }) }),
      ]);
      expect([role, got.map((e) => e.data.label)]).toEqual([role, ['no wallet, 8 down']]);   // before: all four, the walk stopped four levels down
    }
  });

  test('an insurer node, whose origin also serves the marketplace, forwards no event that names a wallet', async () => {
    const { url, emit } = await startNode('insurer');
    const t = await ticketFor(url, bearer);
    const s = await open(`${url}/events?ticket=${encodeURIComponent(t.ticket!)}`);
    await until(() => s.events.length === 1, 'the connected frame');
    emit(event('proof:accepted', { receiptId: 'r-1', walletId: OWN_WALLET }));
    emit(event('audit:event', { type: 'messaging', senderWalletId: OTHER_WALLET }));
    emit(event('batch:built', { batchId: '8', proofCount: 2 }));
    await until(() => s.events.length === 2, 'the walletless event');
    expect(s.events[1]).toMatchObject({ type: 'batch:built', data: { batchId: '8' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.events).toHaveLength(2);
    expect(s.body).not.toMatch(/walletId/i);
  });

  test('a prescriber node, whose stream only its administrator reads, forwards events as the sequencer sent them', async () => {
    const { url, emit } = await startNode('prescriber');
    const s = await open(url + '/events', bearer);
    await until(() => s.events.length === 1, 'the connected frame');
    const reason = `Registry root mismatch: proof expects ${OLD_ROOT} but L2 state is ${L2_ROOT}`;
    const got = await forwarded(s, emit, [
      event('proof:rejected', { reason }),
      event('audit:event', { label: 'wallet, 9 down', ...buried(9, { walletId: OTHER_WALLET }) }),
    ]);
    expect(got.map((e) => e.data.reason ?? e.data.label)).toEqual([reason, 'wallet, 9 down']);
  });
});

describe('a stream that ends lets its connection go as the client asked', () => {
  const sockets: net.Socket[] = [];
  afterAll(() => { for (const socket of sockets) socket.destroy(); });

  /** A client's own connection to the node on `port`: what it has received, and when the node closed it (0 while open). */
  function connect(port: number): { received: string; closedAt: number; send: (text: string) => void } {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    const client = { received: '', closedAt: 0, send: (text: string): void => { socket.write(text); } };
    socket.on('data', (d) => { client.received += d.toString(); });
    socket.on('close', () => { client.closedAt = Date.now(); });
    socket.on('error', () => { /* the close that follows answers */ });
    return client;
  }
  /** An answer's status line and headers, each ending in its CRLF. */
  const head = (answer: string): string => answer.slice(0, answer.indexOf('\r\n\r\n') + 2);
  const statusLine = (answer: string): string => answer.split('\r\n')[0] ?? '';

  test('a client that asked to close its connection has it closed as its stream ends, not held for the keep-alive timeout', async () => {
    const { server } = await startNode('member');
    const port = server.getPort();
    const client = connect(port);
    const session = server.issueDeviceSession().token;
    client.send(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Device-Session: ${session}\r\nConnection: close\r\n\r\n`);
    await until(() => client.received.includes('"type":"connected"'), 'the connected frame');
    expect(statusLine(client.received)).toBe('HTTP/1.1 200 OK');
    expect(head(client.received)).toContain('\r\nConnection: close\r\n');        // before: absent, the head said Connection: keep-alive
    const endedAt = Date.now();
    server.clearDeviceSession();                                                  // the device locks, and the stream its session opened ends
    await until(() => client.closedAt > 0, 'the node to close the connection', 10_000);
    expect(client.closedAt - endedAt).toBeLessThan(1_500);                        // before: about 6,000, Node's keep-alive timeout and its buffer
  });

  test('a client that keeps its connection still gets its stream, and its next request is answered on it once the stream ends', async () => {
    const { server } = await startNode('member');
    const port = server.getPort();
    const client = connect(port);
    const session = server.issueDeviceSession().token;
    client.send(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Device-Session: ${session}\r\n\r\n`);
    await until(() => client.received.includes('"type":"connected"'), 'the connected frame');
    expect(statusLine(client.received)).toBe('HTTP/1.1 200 OK');
    expect(head(client.received)).toContain('\r\nContent-Type: text/event-stream\r\n');
    expect(head(client.received)).toContain('\r\nConnection: keep-alive\r\n');
    server.clearDeviceSession();
    // The last chunk of the stream, and the connection still open.
    await until(() => client.received.endsWith('\r\n0\r\n\r\n'), 'the end of the stream');
    expect(client.closedAt).toBe(0);
    client.received = '';
    client.send(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    await until(() => client.closedAt > 0, 'the answer to the next request');
    expect(statusLine(client.received)).toBe('HTTP/1.1 200 OK');
  });
});

// ── The pages ──────────────────────────────────────────────

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);

/** An EventSource over http.get, which records the URL each stream was opened with. Like a browser's, it is silent once closed. */
function eventSourceRecording(opened: string[]) {
  return class {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    private closed = false;
    private req: http.ClientRequest;
    constructor(url: string) {
      opened.push(url);
      const fail = (): void => { if (!this.closed) this.onerror?.(); };
      this.req = http.get(url, { agent: false }, (res) => {
        if (res.statusCode !== 200) { res.resume(); fail(); return; }
        if (!this.closed) this.onopen?.();
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          for (let at = buf.indexOf('\n\n'); at >= 0; at = buf.indexOf('\n\n')) {
            const line = buf.slice(0, at).split('\n').find((l) => l.startsWith('data:'));
            buf = buf.slice(at + 2);
            if (line && !this.closed) this.onmessage?.({ data: line.slice(5).trim() });
          }
        });
        res.on('error', fail);
      });
      this.req.on('error', fail);
    }
    close(): void {
      this.closed = true;
      this.req.destroy();
    }
  };
}

/** fetch that records each request's path and headers. */
function fetchRecording(calls: Array<{ path: string; method: string; headers: Record<string, string> }>) {
  return (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? 'GET', headers: init.headers ?? {} });
    return fetch(url, init as RequestInit);
  };
}

const storage = (token: string) => ({ getItem: () => token, setItem: () => undefined });

describe('each page opens its node\'s stream with the credential it holds in memory', () => {
  test('the member page trades the device session for a ticket on this origin, and with no session opens nothing', async () => {
    const { server, url } = await startNode('member');
    const opened: string[] = [];
    const calls: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
    const RPC = new Function('location', 'fetch', 'EventSource', `${read('dashboard-member/rpc.js')}\nreturn RPC;`)(
      { origin: url }, fetchRecording(calls), eventSourceRecording(opened));
    const received: any[] = [];

    RPC.connectSSE((ev: unknown) => received.push(ev));
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toEqual([]);                                                   // locked: no session, no stream
    expect(calls).toEqual([]);

    RPC.setDeviceSession(server.issueDeviceSession().token);
    RPC.connectSSE((ev: unknown) => received.push(ev));
    await until(() => received.length > 0, 'the member page\'s stream');
    RPC.disconnectSSE();
    expect(received[0]).toMatchObject({ type: 'connected', role: 'member' });
    expect(calls[0]).toMatchObject({ path: '/events/ticket', method: 'POST' });
    expect(calls[0].headers['X-Device-Session']).toBeTruthy();
    expect(opened[0]).toMatch(new RegExp(`^${url}/events\\?ticket=[A-Za-z0-9_-]+$`));
  });

  test.each([
    ['employer', 'dashboard-employer/rpc.js'],
    ['insurer', 'dashboard-insurer/rpc.js'],
  ])('the %s page trades its admin token for a ticket, and opens the stream when a token is set', async (role, file) => {
    const { url } = await startNode(role);
    const opened: string[] = [];
    const calls: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
    const API = new Function('location', 'localStorage', 'fetch', 'EventSource', `${read(file)}\nreturn API;`)(
      { origin: url }, storage(''), fetchRecording(calls), eventSourceRecording(opened));
    const received: any[] = [];

    API.connectSSE((ev: unknown) => received.push(ev));
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toEqual([]);                                                   // no token: nothing is opened

    API.setAdminToken(TOKEN);                                                     // setting one opens it
    await until(() => received.length > 0, `the ${role} page's stream`);
    API.disconnectSSE();
    expect(received[0]).toMatchObject({ type: 'connected', role });
    expect(calls[0]).toMatchObject({ path: '/events/ticket', method: 'POST' });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opened[0]).toMatch(new RegExp(`^${url}/events\\?ticket=[A-Za-z0-9_-]+$`));
  });

  test('the prescriber page opens the stream once its admin token is typed', async () => {
    const { url } = await startNode('prescriber');
    const opened: string[] = [];
    const calls: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
    const API = new Function('location', 'localStorage', 'fetch', 'EventSource', `${read('dashboard-prescriber/rpc.js')}\nreturn API;`)(
      { origin: url }, storage(''), fetchRecording(calls), eventSourceRecording(opened));
    const received: any[] = [];
    let open = 0;

    API.connectSSE((ev: unknown) => received.push(ev), () => undefined, () => { open++; });
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toEqual([]);

    API.setAdminToken(TOKEN);
    await until(() => received.length > 0, 'the prescriber page\'s stream');
    API.disconnectSSE();
    expect(open).toBe(1);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opened[0]).toMatch(new RegExp(`^${url}/events\\?ticket=[A-Za-z0-9_-]+$`));
  });

  test('the pharmacy page, which holds no node credential until provider sign-in, opens no stream', async () => {
    const opened: string[] = [];
    const calls: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
    const API = new Function('location', 'fetch', 'EventSource', `${read('dashboard-pharmacy/rpc.js')}\nreturn API;`)(
      { origin: 'http://127.0.0.1:1' }, fetchRecording(calls), eventSourceRecording(opened));
    API.sse.connect();
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual([]);                                                   // before: an open /events, the wallet stream
    expect(calls).toEqual([]);
    expect(API.sse.connected).toBe(false);
  });
});
