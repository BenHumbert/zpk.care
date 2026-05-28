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
 * Console Panel — Persistent terminal-style console with SSE connection.
 *
 * Connects to /interactive/console SSE stream and displays real-time
 * compilation progress, proof generation timing, and enrollment steps.
 */

const API_BASE = 'http://127.0.0.1:3030';

export class ConsolePanel {
  constructor() {
    this.output = document.getElementById('console-output');
    this.filters = document.querySelectorAll('.console-filter');
    this.clearBtn = document.getElementById('btn-console-clear');
    this.resizeHandle = document.getElementById('console-resize-handle');
    this.panel = document.getElementById('console-panel');

    this.activeFilter = 'all';
    this.lines = [];
    this.eventSource = null;

    this.init();
  }

  init() {
    // Filter buttons
    this.filters.forEach(btn => {
      btn.addEventListener('click', () => {
        this.filters.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeFilter = btn.dataset.filter;
        this.applyFilter();
      });
    });

    // Clear button
    this.clearBtn.addEventListener('click', () => {
      this.lines = [];
      this.output.innerHTML = '';
    });

    // Resize handle
    this.initResize();

    // Connect SSE
    this.connect();
  }

  connect() {
    this.eventSource = new EventSource(`${API_BASE}/interactive/console`);

    this.eventSource.addEventListener('console', (e) => {
      const event = JSON.parse(e.data);
      this.addLine(event);
    });

    this.eventSource.onopen = () => {
      this.addSystemLine('Connected to console stream');
    };

    this.eventSource.onerror = () => {
      this.addSystemLine('Console connection lost. Reconnecting...');
    };
  }

  addLine(event) {
    const ts = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const elapsed = event.elapsedMs ? ` (${(event.elapsedMs / 1000).toFixed(2)}s)` : '';
    const memStr = event.memoryMB ? ` [${event.memoryMB} MB]` : '';

    const line = {
      type: event.type,
      html: `<span class="ts">[${ts}]</span> ${this.escapeHtml(event.message)}${elapsed}${memStr}`,
    };

    this.lines.push(line);

    const el = document.createElement('div');
    el.className = `console-line ${event.type}`;
    el.innerHTML = line.html;

    if (this.activeFilter !== 'all' && event.type !== this.activeFilter) {
      el.classList.add('hidden');
    }

    this.output.appendChild(el);
    this.scrollToBottom();
  }

  addSystemLine(message) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const el = document.createElement('div');
    el.className = 'console-line info';
    el.innerHTML = `<span class="ts">[${ts}]</span> ${this.escapeHtml(message)}`;
    this.output.appendChild(el);
    this.scrollToBottom();
  }

  applyFilter() {
    const lineEls = this.output.querySelectorAll('.console-line');
    lineEls.forEach((el, i) => {
      if (this.activeFilter === 'all') {
        el.classList.remove('hidden');
      } else {
        const lineType = this.lines[i]?.type;
        if (lineType === this.activeFilter) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });
    this.scrollToBottom();
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.output.scrollTop = this.output.scrollHeight;
    });
  }

  initResize() {
    let startY = 0;
    let startHeight = 0;

    const onMouseMove = (e) => {
      const delta = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(window.innerHeight * 0.6, startHeight + delta));
      this.panel.style.height = `${newHeight}px`;
      document.documentElement.style.setProperty('--console-height', `${newHeight}px`);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    this.resizeHandle.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startHeight = this.panel.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}
