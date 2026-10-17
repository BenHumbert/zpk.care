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
 * FlowchartDashboardServer — HTTP server for the network topology dashboard.
 *
 * Serves static files from visualizer/dist/flowchart/ (including subdirectories)
 * and proxies API calls to the backend L2RpcServer on a separate port.
 *
 * Routes:
 *   GET  /                    → flowchart/index.html
 *   GET  /*.{js,css,html,svg} → static files (supports subdirectories)
 *   GET  /interactive/*       → proxy to backend
 *   POST /interactive/*       → proxy to backend
 *   GET  /flowchart/*         → proxy to backend
 *   POST /flowchart/*         → proxy to backend
 *   GET  /viz/events          → SSE proxy to backend
 *   GET  /events              → SSE proxy to backend
 *   GET  /node/*              → proxy to backend
 *   GET  /health              → proxy to backend
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { resolveBindHost, resolveAllowedOrigins } from '../security/network-policy.js';

export class FlowchartDashboardServer {
  private server: http.Server | null = null;
  private dashboardPort: number;
  private backendPort: number;
  private staticDir: string;

  constructor(dashboardPort: number, backendPort: number) {
    this.dashboardPort = dashboardPort;
    this.backendPort = backendPort;
    // Detect CWD: if we're already inside visualizer/, don't double-nest
    const cwd = process.cwd();
    const inVisualizer = cwd.endsWith('visualizer') || cwd.endsWith('visualizer/') || cwd.endsWith('visualizer\\');
    this.staticDir = inVisualizer
      ? path.resolve(cwd, 'dist', 'flowchart')
      : path.resolve(cwd, 'visualizer', 'dist', 'flowchart');
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.dashboardPort, resolveBindHost(process.env, 'flowchart dashboard'), () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Static file serving — generic directory serving with MIME detection
    if (url === '/' || url === '/index.html') {
      this.serveStaticFile(res, 'index.html');
      return;
    }
    if (method === 'GET' && !url.startsWith('/interactive/') &&
        !url.startsWith('/flowchart/') && !url.startsWith('/node/') &&
        !url.startsWith('/viz/') && url !== '/events' && url !== '/health') {
      // Try to serve as static file
      const filePath = url.slice(1); // Remove leading slash
      if (this.isStaticFile(filePath)) {
        this.serveStaticFile(res, filePath);
        return;
      }
    }

    // SSE proxy routes (special handling — keep connection open)
    if (url === '/interactive/console' || url === '/viz/events' || url === '/events') {
      this.proxySse(req, res, url);
      return;
    }

    // API proxy routes
    if (url.startsWith('/interactive/') ||
        url.startsWith('/flowchart/') ||
        url.startsWith('/node/') ||
        url === '/health') {
      this.proxyRequest(req, res, url);
      return;
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  /** MIME type map for static file extensions. */
  private static MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  /** Check if a URL path looks like a serveable static file (has known extension, no traversal). */
  private isStaticFile(filePath: string): boolean {
    // Block path traversal
    if (filePath.includes('..') || filePath.includes('\\')) return false;
    const ext = path.extname(filePath).toLowerCase();
    return ext in FlowchartDashboardServer.MIME_TYPES;
  }

  /** Serve a static file from the static directory with auto-detected MIME type. */
  private serveStaticFile(res: http.ServerResponse, filePath: string): void {
    // Resolve and verify file is within static dir
    const resolved = path.resolve(this.staticDir, filePath);
    if (!resolved.startsWith(this.staticDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const contentType = FlowchartDashboardServer.MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(resolved, 'utf-8', (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filePath}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(content);
    });
  }

  private proxyRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse, urlPath: string): void {
    // Collect request body
    const chunks: Buffer[] = [];
    clientReq.on('data', (chunk: Buffer) => chunks.push(chunk));
    clientReq.on('end', () => {
      const body = Buffer.concat(chunks);

      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.backendPort,
        path: urlPath,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: `127.0.0.1:${this.backendPort}`,
        },
      };

      const proxyReq = http.request(options, (proxyRes) => {
        // Forward status and headers
        const headers = { ...proxyRes.headers };
        headers['access-control-allow-origin'] = '*';
        clientRes.writeHead(proxyRes.statusCode ?? 200, headers);
        proxyRes.pipe(clientRes);
      });

      proxyReq.on('error', (err) => {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Backend unavailable', details: err.message }));
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }

  private proxySse(clientReq: http.IncomingMessage, clientRes: http.ServerResponse, urlPath: string): void {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: this.backendPort,
      path: urlPath,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      proxyRes.on('data', (chunk: Buffer) => {
        clientRes.write(chunk);
      });

      proxyRes.on('end', () => {
        clientRes.end();
      });
    });

    proxyReq.on('error', (err) => {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end('Backend SSE unavailable: ' + err.message);
    });

    clientReq.on('close', () => {
      proxyReq.destroy();
    });

    proxyReq.end();
  }
}
