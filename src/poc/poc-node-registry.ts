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
 * PoC Node Registry — tracks all nodes in the proof-of-concept network.
 *
 * Provides a central registry of node info (role, port, status, health)
 * and health polling via HTTP /health endpoints.
 */

import http from 'http';
import type { PocNodeInfo, PocNodeStatus, PocEvent, PocEventEmitter } from './poc-types.js';

export class PocNodeRegistry {
  private nodes: Map<string, PocNodeInfo> = new Map();
  private emitter: PocEventEmitter;

  constructor(emitter: PocEventEmitter) {
    this.emitter = emitter;
  }

  register(node: PocNodeInfo): void {
    this.nodes.set(node.id, node);
    this.emitter.emit({
      timestamp: Date.now(),
      source: node.id,
      level: 'info',
      message: `Registered ${node.role} node "${node.displayName}" on port ${node.port}`,
      phase: 'booting',
    });
  }

  updateStatus(id: string, status: PocNodeStatus, error?: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const prev = node.status;
    node.status = status;
    node.error = error;
    if (prev !== status) {
      this.emitter.emit({
        timestamp: Date.now(),
        source: id,
        level: status === 'error' ? 'error' : status === 'running' ? 'success' : 'info',
        message: `${node.displayName}: ${prev} → ${status}${error ? ` (${error})` : ''}`,
        phase: 'booting',
      });
    }
  }

  getAll(): PocNodeInfo[] {
    return [...this.nodes.values()];
  }

  getById(id: string): PocNodeInfo | undefined {
    return this.nodes.get(id);
  }

  /**
   * Poll health endpoints for all registered nodes.
   * Updates status to 'running' on success, 'error' on failure.
   */
  async pollAllHealth(): Promise<void> {
    const promises = [...this.nodes.values()].map((node) =>
      this.pollNodeHealth(node),
    );
    await Promise.allSettled(promises);
  }

  private async pollNodeHealth(node: PocNodeInfo): Promise<void> {
    try {
      const response = await this.httpGet(`${node.url}/health`, 3000);
      if (response.ok) {
        this.updateStatus(node.id, 'running');
      } else {
        this.updateStatus(node.id, 'error', `Health check returned ${response.statusCode}`);
      }
    } catch (err) {
      this.updateStatus(
        node.id,
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private httpGet(url: string, timeoutMs: number): Promise<{ ok: boolean; statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode ?? 0,
            body,
          });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Health check timeout'));
      });
    });
  }
}
