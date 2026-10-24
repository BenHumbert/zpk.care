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
 * Adjuda-GATOR — Shared Dashboard Utilities
 * Common helpers used across all 6 node dashboards.
 */
(function (root) {
  'use strict';

  /** HTML escaping for text and for quoted attribute values: & < > " and ' as entities. */
  function esc(s) {
    if (s === null || s === undefined) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Truncate a hash for display */
  function truncHash(h, len) {
    len = len || 12;
    if (!h) return '--';
    var s = String(h);
    return s.length > len ? esc(s.slice(0, len) + '...') : esc(s);
  }

  /** Format cents as dollars */
  function fmtCents(c) {
    if (c == null) return '--';
    return '$' + (Number(c) / 100).toFixed(2);
  }

  /** Format a date/timestamp */
  function fmtDate(v) {
    if (!v) return '--';
    try { return new Date(v).toLocaleString(); } catch { return String(v); }
  }

  /** Show a toast notification */
  function toast(msg, type) {
    type = type || 'info';
    var c = document.getElementById('toast-container');
    if (!c) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(function () { el.remove(); }, 300);
    }, 4000);
  }

  /**
   * SSE connection with exponential backoff reconnection.
   * @param {string} url - SSE endpoint URL
   * @param {object} opts - { onEvent, onError, onOpen, onConnectionChange }
   * @returns {{ close: Function }} - Call close() to stop reconnecting
   */
  function createSSE(url, opts) {
    opts = opts || {};
    var source = null;
    var delay = 1000;
    var maxDelay = 30000;
    var closed = false;
    var timer = null;

    function connect() {
      if (closed) return;
      try {
        source = new EventSource(url);
        source.onopen = function () {
          delay = 1000;
          if (opts.onOpen) opts.onOpen();
          if (opts.onConnectionChange) opts.onConnectionChange('connected');
        };
        source.onmessage = function (ev) {
          try {
            var data = JSON.parse(ev.data);
            if (opts.onEvent) opts.onEvent(data);
          } catch (_) {
            if (opts.onEvent) opts.onEvent({ raw: ev.data });
          }
        };
        source.onerror = function () {
          if (opts.onError) opts.onError();
          if (opts.onConnectionChange) opts.onConnectionChange('disconnected');
          source.close();
          source = null;
          if (!closed) {
            timer = setTimeout(connect, delay);
            delay = Math.min(delay * 2, maxDelay);
          }
        };
      } catch (_) {
        if (!closed) {
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, maxDelay);
        }
      }
    }

    connect();

    return {
      close: function () {
        closed = true;
        if (timer) clearTimeout(timer);
        if (source) { source.close(); source = null; }
      },
      getSource: function () { return source; },
    };
  }

  // Export
  var utils = { esc: esc, truncHash: truncHash, fmtCents: fmtCents, fmtDate: fmtDate, toast: toast, createSSE: createSSE };
  if (typeof module !== 'undefined' && module.exports) module.exports = utils;
  else root.ZkpUtils = utils;
})(typeof window !== 'undefined' ? window : this);
