#!/usr/bin/env node
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
 *   ZKTRIDENT_CORS_ORIGINS    — Comma-separated CORS origins (default: *)
 *
 * Usage:
 *   npx tsx src/nodes/start-explorer.ts
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const env = process.env;
const port = parseInt(env.ZKTRIDENT_EXPLORER_PORT ?? '8000', 10);
const sequencerUrl = (env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030').replace(/\/+$/, '');
const corsOrigins = env.ZKTRIDENT_CORS_ORIGINS ?? '*';

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

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': corsOrigins,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Proxy /rpc to sequencer
  if (pathname === '/rpc' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const upstream = await fetch(sequencerUrl + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e: any) {
      res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sequencer unreachable: ' + e.message }));
    }
    return;
  }

  // Proxy /health to sequencer
  if (pathname === '/health' && req.method === 'GET') {
    try {
      const upstream = await fetch(sequencerUrl + '/health');
      const text = await upstream.text();
      res.writeHead(upstream.status, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e: any) {
      res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' });
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
        ...corsHeaders(),
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
      res.writeHead(502, corsHeaders());
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
          ...corsHeaders(),
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
        res.writeHead(upstream.status, { ...corsHeaders(), 'Content-Type': ct });
        res.end(text);
      }
    } catch (e: any) {
      res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sequencer unreachable: ' + e.message }));
    }
    return;
  }

  // Static files from explorer/
  const safePath = pathname === '/' ? '/index.html' : pathname;
  if (/^[/a-zA-Z0-9._-]+$/.test(safePath) && !safePath.includes('..')) {
    const filePath = path.join(explorerDir, safePath);
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { ...corsHeaders(), 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
      return;
    } catch {
      // fall through to 404
    }
  }

  res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(port, '0.0.0.0', () => {
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
