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
 * PoC Dashboard Server — Lightweight HTTP server for the monitoring UI.
 *
 * Serves the static dashboard files and provides:
 *   GET /              — poc-dashboard.html
 *   GET /poc-dashboard.js  — Dashboard JavaScript
 *   GET /poc-dashboard.css — Dashboard CSS
 *   GET /api/status    — Full PocStatus JSON (polled by dashboard)
 *   GET /api/events    — SSE stream of PocEvent entries
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import type { PocStatus, PocEvent, PocEventEmitter } from './poc-types.js';

/** Callback to retrieve current PocStatus */
export type StatusProvider = () => PocStatus;

export class PocDashboardServer {
  private server: http.Server | null = null;
  private sseClients: Set<http.ServerResponse> = new Set();
  private port: number;
  private statusProvider: StatusProvider;
  private emitter: PocEventEmitter;
  private unsubscribe?: () => void;
  private staticDir: string;

  constructor(port: number, statusProvider: StatusProvider, emitter: PocEventEmitter) {
    this.port = port;
    this.statusProvider = statusProvider;
    this.emitter = emitter;
    // Static files are in visualizer/dist/ relative to project root
    this.staticDir = path.resolve(process.cwd(), 'visualizer', 'dist');
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        // Subscribe to events for SSE broadcast
        this.unsubscribe = this.emitter.onEvent((event) => this.broadcastSSE(event));
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return this.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (url === '/api/status') {
      this.handleApiStatus(res);
    } else if (url === '/api/events') {
      this.handleApiEvents(req, res);
    } else if (url === '/' || url === '/poc-dashboard.html') {
      this.serveStatic(res, 'poc-dashboard.html', 'text/html');
    } else if (url === '/poc-dashboard.js') {
      this.serveStatic(res, 'poc-dashboard.js', 'application/javascript');
    } else if (url === '/poc-dashboard.css') {
      this.serveStatic(res, 'poc-dashboard.css', 'text/css');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  private handleApiStatus(res: http.ServerResponse): void {
    const status = this.statusProvider();
    const json = JSON.stringify(status, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  private handleApiEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial keepalive
    res.write(': connected\n\n');
    this.sseClients.add(res);

    // Replay recent events from current status
    const status = this.statusProvider();
    for (const event of status.events.slice(-50)) {
      const data = JSON.stringify(event);
      res.write(`event: poc-event\ndata: ${data}\n\n`);
    }

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  private broadcastSSE(event: PocEvent): void {
    const data = JSON.stringify(event);
    const message = `event: poc-event\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      client.write(message);
    }
  }

  private serveStatic(res: http.ServerResponse, filename: string, contentType: string): void {
    const filePath = path.join(this.staticDir, filename);
    fs.readFile(filePath, 'utf-8', (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filename}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  }
}
