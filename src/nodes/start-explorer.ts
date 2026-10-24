#!/usr/bin/env node
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
 * start-explorer.ts — Leviathan Explorer (Public Block Explorer)
 *
 * Lightweight static file server for the public-facing explorer dashboard.
 * Proxies /rpc, /events, and /health to the configured Leviathan sequencer.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_EXPLORER_PORT   — Explorer server port (default: 8000)
 *   ZKTRIDENT_SEQUENCER_URL   — Leviathan sequencer URL (default: http://localhost:3030)
 *   ZKTRIDENT_CORS_ORIGINS    — Comma-separated CORS origins
 *                               (default: the local dashboard origins)
 *   ZKTRIDENT_HOST            — Bind address (default: 127.0.0.1, loopback only)
 *   ZKTRIDENT_PUBLIC_HOSTS    — Comma-separated Host names answered beyond loopback
 *                               and the bind address (default: none)
 *   ZKTRIDENT_RPC_PROXY       — 0 to disable POST /rpc forwarding (default: on,
 *                               limited to the methods the explorer page calls)
 *
 * Usage:
 *   npx tsx src/nodes/start-explorer.ts
 */
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  resolveBindHost, resolveAllowedOrigins, corsOriginHeader, resolveRpcProxyPolicy, resolvePublicHosts,
  requestHostAllowed, bodyTypeAccepted, MISDIRECTED_REQUEST, UNSUPPORTED_BODY_TYPE, NO_FRAMING_HEADERS,
  type HostPolicy,
} from '../security/network-policy.js';

const env = process.env;
const port = parseInt(env.ZKTRIDENT_EXPLORER_PORT ?? '8000', 10);
const bindHost = resolveBindHost(env, 'explorer');
/** A-82: the names this explorer answers to in a request's Host. */
const hostPolicy: HostPolicy = { bindHost, publicHosts: resolvePublicHosts(env) };
const sequencerUrl = (env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030').replace(/\/+$/, '');
const allowedOrigins = resolveAllowedOrigins(env, { role: 'explorer' });
// The explorer's page reaches the sequencer only through this proxy, so it stays on. What
// changes is that it forwards a fixed list of 45 read methods, covering the 27 the page
// calls, instead of relaying whatever method the body happens to name. The /viz/* proxy
// below is GET-only, so the admin viz writes are not reachable through here either.
const rpcProxy = resolveRpcProxyPolicy(env, 'explorer');

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const explorerDir = path.resolve(thisDir, '..', '..', 'explorer');

const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
/** B1: the fixture directory as JSON, built on first request and kept. */
let fixturesJson: string | null = null;

/**
 * CORS headers for one request. The allow-origin header is omitted entirely when the
 * request carries no Origin or an Origin that is not on the allowlist, rather than
 * echoing a wildcard back.
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = corsOriginHeader(req.headers.origin, allowedOrigins);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/**
 * D1/D2: the explorer page's operator token, when it holds one, rides through this proxy to the
 * sequencer, which decides what it opens. Nothing else of the browser's headers is forwarded.
 */
function forwardedCredential(req: IncomingMessage): Record<string, string> {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth ? { Authorization: auth } : {};
}

/**
 * Relays one of the sequencer's event streams to a page, and lets go of it as soon as the page goes. Rejects only while
 * the page is still there to be told the sequencer could not be reached.
 *
 * A-83, from the review of its fix: the relays listened for the page's leaving only once the sequencer's headers had
 * come back. A page that left before then (a reload, a dropped link, a sequencer slow to answer) had already closed, so
 * nothing cancelled the upstream: the relay held the sequencer's stream open for good, writing into the gone page, and
 * each one kept one of the sequencer's SSE slots (it allows 100), so reconnects over a flaky link could use them all up.
 * The upstream request now carries an abort signal, set up before the request goes out, which the page's leaving fires
 * whenever it comes.
 */
async function relayEventStream(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
  const upstreamAbort = new AbortController();
  // The response closes when the page goes, before or after the sequencer answers, and after a normal end, when the
  // abort does nothing. A response queued behind another on a pipelined connection never closes; its request does.
  res.on('close', () => upstreamAbort.abort());
  req.on('close', () => upstreamAbort.abort());
  const pageGone = (): boolean => upstreamAbort.signal.aborted || res.destroyed;
  try {
    // D2: the stream answers a credential — the page's token in a header or in ?token= — and a refusal is relayed as itself.
    const upstream = await fetch(target, {
      headers: { Accept: 'text/event-stream', ...forwardedCredential(req) },
      signal: upstreamAbort.signal,
    });
    if (pageGone()) {
      // The page went as the sequencer answered: let go of the stream now. The cancel rejects when the abort has
      // already errored the body.
      upstream.body?.cancel().catch(() => { /* the abort let go of it first */ });
      return;
    }
    if (upstream.status !== 200) {
      const refusal = await upstream.text();
      if (pageGone()) return;
      res.writeHead(upstream.status, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(refusal);
      return;
    }
    // No Connection header, so Node answers as HTTP/1.1 has a server do: the page's connection stays open after the
    // stream for its next request, unless the page asked to close it, and then it closes as the stream ends. Naming
    // keep-alive here overrode a page's "close", and the connection outlived the stream by Node's keep-alive timeout.
    res.writeHead(200, {
      ...corsHeaders(req),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    // A read rejects when the page's leaving aborts the stream, and then there is no one to write to, or when the
    // sequencer drops it, and then the page is told the stream has ended.
    pump().catch(() => { if (!pageGone()) res.end(); });
  } catch (err) {
    // The page went first: the abort, or a failure that came with it, has no one to tell.
    if (pageGone()) return;
    throw err;
  }
}

/*
 * A-83, found by the security posture check of 2026-10-24: every request's URL was built from its
 * own Host header, in an async handler with nothing to catch what it threw, so one request with a
 * malformed Host (`Host: a b`) rejected the handler's promise and Node ended the process, taking the
 * explorer and the console pages it serves down for everyone. Only the path and query are read, so
 * they are read against a fixed base; a request whose path cannot be read at all is answered 400,
 * and anything else one request throws is that request's 500.
 */
const REQUEST_URL_BASE = 'http://localhost';

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.warn('  [explorer] %s request failed: %s', req.method, err instanceof Error ? err.message : String(err));
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { ...corsHeaders(req), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error' }));
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A-82: the request must name this explorer in its Host, or a page rebound to loopback could read every answer.
  if (!requestHostAllowed(req, hostPolicy)) {
    res.writeHead(421, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: MISDIRECTED_REQUEST }));
    return;
  }
  // A-82: no other site may frame the explorer's pages.
  for (const [name, value] of Object.entries(NO_FRAMING_HEADERS)) res.setHeader(name, value);

  let url: URL;
  try {
    url = new URL(req.url ?? '/', REQUEST_URL_BASE);
  } catch {
    res.writeHead(400, { ...corsHeaders(req), 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  // A-82: a body method declares JSON, the one type the explorer forwards, so a browser asks before it sends one
  // cross-site.
  if (!bodyTypeAccepted(req)) {
    res.writeHead(415, { ...corsHeaders(req), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: UNSUPPORTED_BODY_TYPE }));
    return;
  }

  // Proxy /rpc to sequencer
  if (pathname === '/rpc' && req.method === 'POST') {
    if (!rpcProxy.enabled) {
      res.writeHead(404, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'RPC proxying is disabled on this explorer' } }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      // Only the methods the explorer's own page calls. Everything else — admin controls,
      // witness endpoints, anything added to the sequencer later — is refused here rather
      // than relayed, so this proxy cannot be used to reach past the explorer.
      let method: string | undefined;
      try {
        method = (JSON.parse(body.toString('utf-8')) as { method?: string }).method;
      } catch {
        res.writeHead(400, { ...corsHeaders(req), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      if (!method || !rpcProxy.allowed.has(method)) {
        res.writeHead(403, { ...corsHeaders(req), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not available through the explorer: ' + (method ?? 'none') } }));
        return;
      }

      const upstream = await fetch(sequencerUrl + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forwardedCredential(req) },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e: any) {
      res.writeHead(502, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sequencer unreachable: ' + e.message }));
    }
    return;
  }

  // Proxy /health to sequencer
  if (pathname === '/health' && req.method === 'GET') {
    try {
      const upstream = await fetch(sequencerUrl + '/health');
      const text = await upstream.text();
      res.writeHead(upstream.status, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e: any) {
      res.writeHead(502, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sequencer unreachable' }));
    }
    return;
  }

  // Proxy /events SSE to sequencer
  if (pathname === '/events' && req.method === 'GET') {
    try {
      await relayEventStream(req, res, sequencerUrl + '/events' + url.search);
    } catch {
      // A-83: a page that has gone, or has had its answer, is written nothing more.
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(502, corsHeaders(req));
      res.end('data: {"error":"Sequencer unreachable"}\n\n');
    }
    return;
  }

  // Proxy /viz/* to sequencer (viz/events SSE, viz/entities, viz/state)
  if (pathname.startsWith('/viz/') && req.method === 'GET') {
    try {
      if (pathname === '/viz/events') {
        await relayEventStream(req, res, sequencerUrl + pathname + url.search);
      } else {
        const upstream = await fetch(sequencerUrl + pathname + url.search, { headers: forwardedCredential(req) });
        const text = await upstream.text();
        const ct = upstream.headers.get('content-type') || 'application/json';
        res.writeHead(upstream.status, { ...corsHeaders(req), 'Content-Type': ct });
        res.end(text);
      }
    } catch (e: any) {
      if (res.destroyed || res.writableEnded) return;   // A-83, as for /events
      res.writeHead(502, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sequencer unreachable: ' + e.message }));
    }
    return;
  }

  // Static files from explorer/
  // B1 (first half): the fixture directory the console displays, served here as a static file
  // instead of inside the sequencer's admin-gated state dump. Built on first request so this
  // process still starts instantly; the fixture module also loads the formulary.
  if (pathname === '/fixtures.json' && req.method === 'GET') {
    try {
      if (!fixturesJson) {
        const mod = await import('../data/fixture-directory.js');
        fixturesJson = JSON.stringify(mod.fixtureDirectory());
      }
      res.writeHead(200, { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
      res.end(fixturesJson);
    } catch (err) {
      res.writeHead(500, { ...corsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  const safePath = pathname === '/' ? '/index.html' : pathname;
  if (/^[/a-zA-Z0-9._-]+$/.test(safePath) && !safePath.includes('..')) {
    const filePath = path.join(explorerDir, safePath);
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { ...corsHeaders(req), 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
      return;
    } catch {
      // fall through to 404
    }
  }

  res.writeHead(404, { ...corsHeaders(req), 'Content-Type': 'text/plain' });
  res.end('Not found');
}

server.listen(port, bindHost, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  LEVIATHAN EXPLORER — Adjuda-GATOR    ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Explorer:      http://localhost:%d', port);
  console.log('  Sequencer:     %s', sequencerUrl);
  console.log('  Dashboard dir: %s', explorerDir);
  console.log('');
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
