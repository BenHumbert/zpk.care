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
 * The sequencer client holds what a sequencer sends it to a ceiling (A-83, the client half).
 *
 * What was wrong: L2Client.connectEvents appended every chunk of the event stream to one string and split all of it
 * again on each chunk, with no limit, so an event that never ended grew until the node ran out of memory; each chunk
 * was decoded on its own, so a character split between two chunks arrived as replacement characters. httpRequest read
 * an RPC response body whole whatever its length, and a connection closed partway through a body left the call waiting
 * for ever. A sequencer, a replica, or anything on the path between could exhaust every node that holds a stream open.
 *
 * How it was found: the security posture check of 2026-10-24 (A-83, l2-client.ts lines 597-604 and 722-725).
 *
 * What is true now: an unfinished event longer than MAX_SSE_FRAME_CHARS (1 Mi characters) is dropped with its
 * connection and the client reconnects; only newly arrived text is searched for the blank line that ends a frame, so
 * one split across two chunks still ends it; the stream is decoded as UTF-8 across chunks. An RPC response body over
 * the client's ceiling (DEFAULT_MAX_RESPONSE_BYTES, 64 MiB, unless maxResponseBytes sets another; a state snapshot is
 * allowed MAX_SNAPSHOT_RESPONSE_BYTES) is refused by its declared length or as it arrives, and a body cut off partway
 * fails the call.
 *
 * Each test runs the client against a small local server that sends exactly the bytes under test.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { L2Client } from '../src/l2/l2-client.js';
import type { L2ChainEvent } from '../src/l2/l2-node.js';

jest.setTimeout(30_000);

const MIB = 1024 * 1024;

/** A client with options the type may not name, so this file compiles against the client before the fix too. */
const client = (options: Record<string, unknown>): L2Client => new L2Client(options as any);

/** One SSE frame as the sequencer writes it. */
const frame = (event: Record<string, unknown>): string => `data: ${JSON.stringify(event)}\n\n`;

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function shut(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Waits until `done()` holds or `ms` pass; the assertions after it say which. */
async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

/** How a call ends within `ms`: 'resolved', 'rejected: <message>', or 'still waiting'. */
async function outcomeWithin(call: Promise<unknown>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
  try {
    return await Promise.race([call.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`), waiting]);
  } finally {
    clearTimeout(timer);
  }
}

/** An event stream at /events: each connection is handed to `onConnect` with its index; `closed` lists the ones the client dropped. */
async function streamServer(onConnect: (res: http.ServerResponse, index: number) => void) {
  let connections = 0;
  const closed: number[] = [];
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/events')) { res.writeHead(404); res.end(); return; }
    const index = connections++;
    res.on('close', () => closed.push(index));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    onConnect(res, index);
  });
  const url = await listen(server);
  return { server, url, closed, connections: () => connections };
}

/** An RPC endpoint whose every answer is written by `answer`. */
async function rpcServer(answer: (res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => answer(res));
  });
  const url = await listen(server);
  return { server, url };
}

describe('the event stream', () => {
  test('an event that never ends is dropped with its connection past MAX_SSE_FRAME_CHARS, and the client reconnects', async () => {
    const s = await streamServer((res, index) => {
      res.write(frame({ type: 'node:tick', timestamp: index, data: { connection: index } }));
      if (index === 0) {
        // Then 18 chunks of 64 KiB with no blank line: one unfinished event of over 1 Mi characters.
        const chunk = 'x'.repeat(64 * 1024);
        res.write('data: ');
        for (let i = 0; i < 18; i++) res.write(chunk);
      }
    });
    const events: L2ChainEvent[] = [];
    const disconnect = client({ sequencerUrl: s.url, retryBaseDelayMs: 20 }).connectEvents((e) => events.push(e));
    try {
      await until(() => s.connections() >= 2 && events.length >= 2 && s.closed.includes(0), 8_000);
      expect(s.closed).toContain(0);                                         // before: the first connection stayed open, its buffer growing
      expect(s.connections()).toBe(2);
      expect(events.map((e) => (e.data as { connection: number }).connection)).toEqual([0, 1]);
    } finally {
      disconnect();
      await shut(s.server);
    }
  });

  test('the ceiling is 1 Mi characters, far above any event the sequencer sends', async () => {
    const { MAX_SSE_FRAME_CHARS } = await import('../src/l2/l2-client.js') as any;
    expect(MAX_SSE_FRAME_CHARS).toBe(MIB);
    // A long event under the ceiling is delivered whole, in many chunks.
    const name = 'n'.repeat(200 * 1024);
    const s = await streamServer((res) => {
      const text = frame({ type: 'node:tick', timestamp: 1, data: { name } });
      for (let at = 0; at < text.length; at += 16 * 1024) res.write(text.slice(at, at + 16 * 1024));
    });
    const events: L2ChainEvent[] = [];
    const disconnect = client({ sequencerUrl: s.url, retryBaseDelayMs: 20 }).connectEvents((e) => events.push(e));
    try {
      await until(() => events.length >= 1, 8_000);
      expect(events).toHaveLength(1);
      expect((events[0].data as { name: string }).name).toBe(name);
      expect(s.closed).toEqual([]);
    } finally {
      disconnect();
      await shut(s.server);
    }
  });

  test('a character split between two chunks arrives whole', async () => {
    const name = 'Zoë 東京 €';
    const bytes = Buffer.from(frame({ type: 'node:tick', timestamp: 1, data: { name } }));
    const cut = bytes.indexOf(Buffer.from('東')) + 1;                         // inside the three bytes of one character
    const s = await streamServer((res) => {
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.write(bytes.subarray(cut)), 100);
    });
    const events: L2ChainEvent[] = [];
    const disconnect = client({ sequencerUrl: s.url }).connectEvents((e) => events.push(e));
    try {
      await until(() => events.length >= 1, 8_000);
      expect((events[0]?.data as { name?: string } | undefined)?.name).toBe(name);   // before: replacement characters where 東 was
    } finally {
      disconnect();
      await shut(s.server);
    }
  });

  test('a blank line split between two chunks still ends the frame', async () => {
    const s = await streamServer((res) => {
      res.write(`data: ${JSON.stringify({ type: 'node:tick', timestamp: 1, data: { n: 1 } })}\n`);
      setTimeout(() => res.write(`\ndata: ${JSON.stringify({ type: 'node:tick', timestamp: 2, data: { n: 2 } })}\n\n`), 100);
    });
    const events: L2ChainEvent[] = [];
    const disconnect = client({ sequencerUrl: s.url }).connectEvents((e) => events.push(e));
    try {
      await until(() => events.length >= 2, 8_000);
      expect(events.map((e) => (e.data as { n: number }).n)).toEqual([1, 2]);
    } finally {
      disconnect();
      await shut(s.server);
    }
  });
});

describe('RPC response bodies', () => {
  test('a body over maxResponseBytes is refused as it arrives', async () => {
    const s = await rpcServer((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });            // chunked: no declared length
      res.write('{"jsonrpc":"2.0","id":1,"result":"');
      for (let i = 0; i < 64; i++) res.write('y'.repeat(1024));
      res.end('"}');
    });
    try {
      await expect(client({ sequencerUrl: s.url, maxResponseBytes: 16 * 1024 }).getStatus())
        .rejects.toThrow('Response body exceeds 16384 bytes');                 // before: read whole
    } finally {
      await shut(s.server);
    }
  });

  test('a declared length over the default ceiling of 64 MiB is refused before the body is read', async () => {
    const { DEFAULT_MAX_RESPONSE_BYTES } = await import('../src/l2/l2-client.js') as any;
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(64 * MIB);
    const s = await rpcServer((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(100 * MIB) });
      res.write('{"jsonrpc":"2.0"');                                          // and the rest never comes
    });
    try {
      await expect(client({ sequencerUrl: s.url, timeoutMs: 3_000 }).getStatus())
        .rejects.toThrow(`Response body exceeds ${64 * MIB} bytes`);           // before: waited, then "Request timeout"
    } finally {
      await shut(s.server);
    }
  });

  test('a state snapshot is held to the larger snapshot ceiling, not the default', async () => {
    const { MAX_SNAPSHOT_RESPONSE_BYTES } = await import('../src/l2/l2-client.js') as any;
    expect(MAX_SNAPSHOT_RESPONSE_BYTES).toBe(256 * MIB);
    const s = await rpcServer((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(100 * MIB) });   // over 64 MiB, under 256
      res.write('{', () => res.socket?.destroy());
    });
    try {
      const c = client({ sequencerUrl: s.url, timeoutMs: 3_000 });
      await expect(c.getStatus()).rejects.toThrow(`Response body exceeds ${64 * MIB} bytes`);
      const outcome = await outcomeWithin(c.requestSnapshot(), 5_000);
      expect(outcome).toMatch(/^rejected: /);                                  // refused for being cut off ...
      expect(outcome).not.toMatch(/exceeds/);                                  // ... not for its declared size
    } finally {
      await shut(s.server);
    }
  });

  test('a body cut off partway fails the call instead of leaving it waiting', async () => {
    const s = await rpcServer((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      res.write('{"jsonrpc":"2.0",', () => res.socket?.destroy());
    });
    try {
      const outcome = await outcomeWithin(client({ sequencerUrl: s.url, timeoutMs: 60_000 }).getStatus(), 5_000);
      expect(outcome).toMatch(/^rejected: /);                                  // before: still waiting
    } finally {
      await shut(s.server);
    }
  });

  test('a body within the ceiling is read whole, a character split between chunks included', async () => {
    const s = await rpcServer((res) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { running: true, name: 'Zoë 東京' } }));
      const cut = body.indexOf(Buffer.from('東')) + 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(body.subarray(0, cut));
      setTimeout(() => res.end(body.subarray(cut)), 50);
    });
    try {
      expect(await client({ sequencerUrl: s.url, maxResponseBytes: 1024 }).getStatus()).toEqual({ running: true, name: 'Zoë 東京' });
    } finally {
      await shut(s.server);
    }
  });
});
