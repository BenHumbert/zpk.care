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
 * EntityRegistry — Maps wallet IDs to display names and metadata.
 */

import { ACTOR_COLORS } from './utils.js';

export class EntityRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.entities = new Map();
  }

  /** Fetch entity registry from the server */
  async fetch(baseUrl = 'http://127.0.0.1:3030') {
    try {
      const res = await fetch(`${baseUrl}/viz/entities`);
      if (!res.ok) return;
      const entities = await res.json();
      for (const e of entities) {
        this.entities.set(e.walletId, e);
      }
    } catch {
      console.warn('[EntityRegistry] Failed to fetch entities, will retry...');
    }
  }

  /** Get entity by wallet ID */
  get(walletId) {
    return this.entities.get(walletId);
  }

  /** Get display name for a wallet ID */
  getName(walletId) {
    const e = this.entities.get(walletId);
    return e ? e.displayName : walletId;
  }

  /** Get color for entity type */
  getColor(type) {
    return ACTOR_COLORS[type] || '#888';
  }

  /** Get all entities */
  getAll() {
    return [...this.entities.values()];
  }

  /** Get all entities of a given type */
  getByType(type) {
    const result = [];
    for (const e of this.entities.values()) {
      if (e.type === type) result.push(e);
    }
    return result;
  }
}
