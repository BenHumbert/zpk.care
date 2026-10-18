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
 *   ZKTRIDENT_RPC_PROXY       — 0 to disable POST /rpc forwarding (default: on,
 *                               limited to the methods the explorer page calls)
 *
 * Usage:
 *   npx tsx src/nodes/start-explorer.ts
 */
import http from 'http';
import type { IncomingMessage } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveBindHost, resolveAllowedOrigins, corsOriginHeader, resolveRpcProxyPolicy } from '../security/network-policy.js';

const env = process.env;
const port = parseInt(env.ZKTRIDENT_EXPLORER_PORT ?? '8000', 10);
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
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
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
        headers: { 'Content-Type': 'application/json' },
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
      const upstream = await fetch(sequencerUrl + '/events', {
        headers: { Accept: 'text/event-stream' },
      });
      res.writeHead(200, {
        ...corsHeaders(req),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      if (upstream.body) {
        const reader = (upstream.body as any).getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch(() => res.end());
        req.on('close', () => { try { reader.cancel(); } catch {} });
      } else {
        res.end();
      }
    } catch {
      res.writeHead(502, corsHeaders(req));
      res.end('data: {"error":"Sequencer unreachable"}\n\n');
    }
    return;
  }

  // Proxy /viz/* to sequencer (viz/events SSE, viz/entities, viz/state)
  if (pathname.startsWith('/viz/') && req.method === 'GET') {
    try {
      if (pathname === '/viz/events') {
        // SSE proxy
        const upstream = await fetch(sequencerUrl + pathname, {
          headers: { Accept: 'text/event-stream' },
        });
        res.writeHead(200, {
          ...corsHeaders(req),
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        if (upstream.body) {
          const reader = (upstream.body as any).getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          pump().catch(() => res.end());
          req.on('close', () => { try { reader.cancel(); } catch {} });
        } else {
          res.end();
        }
      } else {
        const upstream = await fetch(sequencerUrl + pathname + url.search);
        const text = await upstream.text();
        const ct = upstream.headers.get('content-type') || 'application/json';
        res.writeHead(upstream.status, { ...corsHeaders(req), 'Content-Type': ct });
        res.end(text);
      }
    } catch (e: any) {
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
});

server.listen(port, resolveBindHost(env, 'explorer'), () => {
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
