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
 * One malformed request, or a sequencer that drops a stream, no longer ends the explorer, and a page that leaves a stream
 * no longer leaves the sequencer's open behind it (A-83, the explorer half).
 *
 * What was wrong: start-explorer.ts built every request's URL as `new URL(req.url, 'http://' + req.headers.host)` in an
 * async request handler with nothing to catch what it threw. A Host header that is not a host (`Host: a b`), or a
 * request target that is not a URL (`GET http://[`), threw ERR_INVALID_URL, the handler's promise rejected with no one
 * to handle it, and Node ended the process: the explorer, and the console pages it serves, were down for everyone until
 * something restarted it. Anything that could reach the port could do it with one line of text.
 *
 * How it was found: the security posture check of 2026-10-24 (A-83, start-explorer.ts lines 92-93). The review of the
 * fix found a second way down: when a page left an event stream, the relay cancelled its upstream reader inside a
 * try/catch, but cancel() answers with a promise, and that promise rejects when the upstream had already failed. A
 * sequencer that restarted mid-stream, and then the page going, ended the process the same way. A further review, of
 * the code next to that fix, found a leak: the relays listened for the page's leaving only once the sequencer's headers
 * had come back. A page that left before then had already closed, so nothing cancelled the upstream; the explorer held
 * the sequencer's stream open for good, writing into the gone page, and each such stream kept one of the sequencer's 100
 * SSE slots, which reconnects over a flaky link could use up until the sequencer answered "Too many SSE connections".
 *
 * What is true now: a Host the explorer does not answer to is refused 421 before anything reads it (A-82); the path and
 * query are read against a fixed base; a request target that still cannot be read is answered 400; anything else one
 * request throws is that request's 500; and every promise a relay makes when its page or its sequencer goes is handled.
 * The process keeps serving. A relay's request to the sequencer carries an abort signal, set up before the request goes
 * out and fired when the page goes, so the sequencer's stream closes with the page whether or not the sequencer has
 * answered yet, and a page that has gone is written nothing.
 *
 * The drop tests' running time, nearly 8 s each, showed one more fault. The relay's head named "Connection: keep-alive"
 * itself, which overrode a page's "Connection: close", so once the sequencer dropped a stream the explorer held the
 * page's connection open for Node's keep-alive timeout, about 6 s, though HTTP/1.1 has a server close the connection
 * once it has answered a request that asked it to. The head now names no connection option and Node chooses: a page
 * that asked to close is told the connection will close, and it closes as the stream ends; any other page keeps its
 * connection for its next request, as before.
 *
 * The explorer runs as its own process here, as the launcher runs it: once pointed at a sequencer that is not there,
 * once at a stand-in that sends one event on a stream and drops the connection, noting when, with one page that asks to
 * close its connection and one that keeps it, and once at a stand-in whose streams stay open and can hold their headers
 * back, which records when the explorer closes each one.
 */
import http from 'http';
import net from 'net';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

jest.setTimeout(120_000);

const REPO = path.resolve(__dirname, '..');

interface Explorer { child: ChildProcess; port: number; stderr: () => string }

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

/** The explorer as the launcher starts it, relaying to `sequencerUrl`; resolves once it serves its pages. */
async function startExplorer(sequencerUrl: string): Promise<Explorer> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'nodes', 'start-explorer.ts')], {
    cwd: REPO,
    env: { ...process.env, ZKTRIDENT_EXPLORER_PORT: String(port), ZKTRIDENT_SEQUENCER_URL: sequencerUrl, ZKTRIDENT_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/index.html`); if (r.status > 0) break; } catch { /* not yet */ }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('explorer did not start: ' + stderr);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { child, port, stderr: () => stderr };
}

function stop(explorer: Explorer | null): void {
  if (explorer && explorer.child.exitCode === null) { try { explorer.child.kill(); } catch { /* best effort */ } }
}

/** Sends `text` to `port` as it is and returns all of the answer, or '' when the connection closed without one. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let answer = '';
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('data', (d) => { answer += d.toString(); });
    socket.on('close', () => resolve(answer));
    socket.on('error', () => { /* the close that follows answers */ });
    socket.write(text);
  });
}

const statusLine = (answer: string): string => answer.split('\r\n')[0] ?? '';

/** An answer's status line and headers, each ending in its CRLF. */
const head = (answer: string): string => answer.slice(0, answer.indexOf('\r\n\r\n') + 2);

/** Resolves once `check` holds or `ms` have passed, whichever comes first; the assertions after it say which. */
async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

interface Page { received: () => string; leave: () => void }

/** A page's one connection to the explorer: it asks for each target in turn, keeps what comes back, and can leave. */
function openPage(port: number, targets: string[]): Page {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (d) => { received += d.toString(); });
  socket.on('error', () => { /* the page is leaving */ });
  socket.write(targets.map((target) => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`).join(''));
  return { received: () => received, leave: () => socket.destroy() };
}

describe('a malformed request', () => {
  let explorer: Explorer | null = null;
  beforeAll(async () => { explorer = await startExplorer('http://127.0.0.1:1'); }, 90_000);
  afterAll(() => stop(explorer));

  test('a Host header that is not a host is answered, and the explorer keeps serving', async () => {
    const { port, child } = explorer!;
    const status = statusLine(await raw(port, 'GET /index.html HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n'));
    expect(status).toBe('HTTP/1.1 421 Misdirected Request');                  // before: '' — the process had exited
    expect(child.exitCode).toBeNull();
    const page = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(page.status).toBe(200);
  });

  test('a request target that is not a URL is answered 400, and the explorer keeps serving', async () => {
    const { port, child } = explorer!;
    for (const target of ['http://[', 'http://a%zz/', '//[/x']) {
      const status = statusLine(await raw(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      expect([target, status]).toEqual([target, 'HTTP/1.1 400 Bad Request']);  // before: '' — the process had exited
    }
    expect(child.exitCode).toBeNull();
    const page = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(page.status).toBe(200);
  });

  test('the explorer still answers what it answered before: its proxy reports the missing sequencer', async () => {
    const { port, child } = explorer!;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(502);
    expect(await health.json()).toEqual({ error: 'Sequencer unreachable' });
    // A page that is still there when its stream cannot be opened is told so, as before.
    const events = await fetch(`http://127.0.0.1:${port}/events`);
    expect([events.status, await events.text()]).toEqual([502, 'data: {"error":"Sequencer unreachable"}\n\n']);
    const viz = await fetch(`http://127.0.0.1:${port}/viz/events`);
    expect([viz.status, (await viz.json() as { error?: string }).error]).toEqual([502, expect.stringMatching(/^Sequencer unreachable: /)]);
    expect(child.exitCode).toBeNull();
  });
});

describe('a sequencer that drops an event stream part-way', () => {
  let explorer: Explorer | null = null;
  let upstream: http.Server | null = null;
  /** When the stand-in last dropped a stream, by this process's clock; a test sets it to 0 before it asks for one. */
  let droppedAt = 0;

  beforeAll(async () => {
    // One event on each stream, then the connection drops, as it does when a sequencer restarts.
    upstream = http.createServer((req, res) => {
      if (req.url?.startsWith('/events') || req.url?.startsWith('/viz/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"connected"}\n\n');
        setTimeout(() => { droppedAt = Date.now(); res.socket?.destroy(); }, 200);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not found"}');
    });
    const server = upstream;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const a = server.address();
    explorer = await startExplorer(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
  }, 90_000);

  afterAll(async () => {
    stop(explorer);
    const server = upstream;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  for (const stream of ['/events', '/viz/events']) {
    test(`${stream}: the relay ends when the sequencer drops it and closes the connection of a page that asked it to, and the explorer keeps serving after the page goes`, async () => {
      const { port, child, stderr } = explorer!;
      droppedAt = 0;
      // The page reads the event and the end the explorer sends when the sequencer drops, then its connection closes.
      const answer = await raw(port, `GET ${stream}?token=t HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      const closedAt = Date.now();
      expect(statusLine(answer)).toBe('HTTP/1.1 200 OK');
      expect(answer).toContain('data: {"type":"connected"}');
      // The page asked to close, so the explorer says the connection will close, and closes it as the stream ends.
      expect(head(answer)).toContain('\r\nConnection: close\r\n');   // before: absent, the head said 'Connection: keep-alive'
      expect(closedAt - droppedAt).toBeLessThan(1_500);               // before: about 6,000, Node's keep-alive timeout ran out first
      await new Promise((r) => setTimeout(r, 1_500));
      expect([child.exitCode, stderr()]).toEqual([null, expect.not.stringContaining('terminated')]);   // before: [1, "...TypeError: terminated..."]
      const page = await fetch(`http://127.0.0.1:${port}/index.html`);
      expect(page.status).toBe(200);
    });

    test(`${stream}: a page that keeps its connection still gets the stream, and the connection answers its next request once the stream ends`, async () => {
      const { port } = explorer!;
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      let closed = false;
      socket.on('data', (d) => { received += d.toString(); });
      socket.on('close', () => { closed = true; });
      socket.on('error', () => { /* the close that follows answers */ });
      socket.write(`GET ${stream}?token=t HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      // The event, then the last chunk the explorer sends when the sequencer drops the stream.
      await waitFor(() => received.endsWith('\r\n0\r\n\r\n'), 5_000);
      const answer = received;
      expect(statusLine(answer)).toBe('HTTP/1.1 200 OK');
      expect(head(answer)).toContain('\r\nContent-Type: text/event-stream\r\n');
      expect(head(answer)).toContain('\r\nConnection: keep-alive\r\n');
      expect(answer).toContain('data: {"type":"connected"}');
      expect(answer.endsWith('\r\n0\r\n\r\n')).toBe(true);
      // The connection outlives the stream and answers the page's next request on it.
      received = '';
      socket.write(`GET /index.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      await waitFor(() => closed, 5_000);
      expect([closed, statusLine(received)]).toEqual([true, 'HTTP/1.1 200 OK']);
    });
  }
});

describe('a page that leaves an event stream', () => {
  let explorer: Explorer | null = null;
  let upstream: http.Server | null = null;
  /** Each stream request the stand-in has had: when it answered, and when the explorer closed it (0 for not yet). */
  const opened: Array<{ url: string; answeredAt: number; closedAt: number }> = [];

  beforeAll(async () => {
    // Each stream stays open with a heartbeat until the explorer closes it. On ?slow=1 its headers come 600 ms late, as
    // they do from a sequencer slow to answer, so a page can leave before they arrive; on ?refuse=1 it is refused.
    upstream = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (!url.startsWith('/events') && !url.startsWith('/viz/events')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"Not found"}');
        return;
      }
      if (url.includes('refuse=1')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"Unauthorized"}');
        return;
      }
      const seen = { url, answeredAt: 0, closedAt: 0 };
      opened.push(seen);
      let heartbeat: NodeJS.Timeout | undefined;
      const answer = setTimeout(() => {
        seen.answeredAt = Date.now();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"connected"}\n\n');
        heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 200);
      }, url.includes('slow=1') ? 600 : 0);
      req.on('close', () => { seen.closedAt = Date.now(); clearTimeout(answer); clearInterval(heartbeat); });
    });
    const server = upstream;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const a = server.address();
    explorer = await startExplorer(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
  }, 90_000);

  afterAll(async () => {
    stop(explorer);
    const server = upstream;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** The explorer is still up, has logged no failure, and serves its page. */
  async function stillServing(): Promise<void> {
    const { port, child, stderr } = explorer!;
    expect([child.exitCode, stderr()]).toEqual([null, expect.not.stringMatching(/Unhandled|AbortError|terminated|request failed/)]);
    const page = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(page.status).toBe(200);
  }

  for (const stream of ['/events', '/viz/events']) {
    test(`${stream}: a page that leaves before the sequencer answers closes the sequencer's stream, and the explorer keeps serving`, async () => {
      opened.length = 0;
      const target = `${stream}?token=t&slow=1`;
      const page = openPage(explorer!.port, [target]);
      // The page leaves about 100 ms after its request reaches the sequencer, which has yet to answer.
      await waitFor(() => opened.length === 1, 10_000);
      await new Promise((r) => setTimeout(r, 100));
      const [seen] = opened;
      expect(seen).toMatchObject({ url: target, answeredAt: 0, closedAt: 0 });
      page.leave();
      await waitFor(() => seen.closedAt > 0, 2_000);
      expect(seen.closedAt).toBeGreaterThan(0);   // before: 0 — the explorer held the sequencer's stream open for good
      // Past the moment the sequencer would have answered, when the relay used to start writing into the gone page.
      await new Promise((r) => setTimeout(r, 700));
      await stillServing();
    });

    test(`${stream}: a page that leaves once the stream is flowing closes the sequencer's stream too`, async () => {
      opened.length = 0;
      const page = openPage(explorer!.port, [`${stream}?token=t`]);
      await waitFor(() => page.received().includes('data: {"type":"connected"}'), 10_000);
      expect(page.received()).toContain('data: {"type":"connected"}');
      const [seen] = opened;
      page.leave();
      await waitFor(() => seen.closedAt > 0, 2_000);
      expect(seen.closedAt).toBeGreaterThan(0);
      await stillServing();
    });
  }

  test('a page that asks for both streams on one connection and leaves before the sequencer answers closes both', async () => {
    opened.length = 0;
    // The second request waits behind the first on the connection. Its response is not on the socket yet, so it never
    // closes when the page goes; only its request does, and a relay that heard only the response would keep it open.
    const targets = ['/events?token=t&slow=1', '/viz/events?token=t&slow=1'];
    const page = openPage(explorer!.port, targets);
    await waitFor(() => opened.length === 2, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(opened.map((s) => s.answeredAt)).toEqual([0, 0]);
    page.leave();
    await waitFor(() => opened.every((s) => s.closedAt > 0), 2_000);
    const closed = Object.fromEntries(opened.map((s) => [s.url, s.closedAt > 0]));
    expect(closed).toEqual({ [targets[0]]: true, [targets[1]]: true });   // before: both false — neither stream was closed
    await new Promise((r) => setTimeout(r, 700));
    await stillServing();
  });

  test('a stream the sequencer refuses still reaches the page as the refusal', async () => {
    for (const stream of ['/events', '/viz/events']) {
      const answer = await fetch(`http://127.0.0.1:${explorer!.port}${stream}?refuse=1`);
      expect([stream, answer.status, await answer.text()]).toEqual([stream, 401, '{"error":"Unauthorized"}']);
    }
    await stillServing();
  });
});
