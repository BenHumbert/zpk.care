/**
 * Adjuda-GATOR — Shared Dashboard Utilities
 * Common helpers used across all 6 node dashboards.
 */
(function (root) {
  'use strict';

  /** XSS-safe HTML escaping */
  function esc(s) {
    if (s === null || s === undefined) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
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
