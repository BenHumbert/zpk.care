/**
 * Reads what a dashboard is told, never what it says: page.on('response') for allowlisted paths, cut down to
 * allowlisted fields. Request bodies are never touched (derive-wallet's request carries the member's identity
 * fields; the activation request carries the claim secret). Captures stay in this process's memory; secret ones are
 * never logged, and none of them is written to take.json.
 *
 *   const sniff = new Sniffer({ log });
 *   sniff.watch(page, SNIFF_RULES);
 *   const since = Date.now();
 *   await page.locator('#btn-import-go').click();
 *   const imp = await sniff.waitFor('import', { since, timeout: 120000 });
 */

/**
 * Picks dotted paths out of a JSON value: 'data.walletId', 'data.results[].tokenId'. The result keeps the same
 * shape, with only those leaves.
 */
export function pickPaths(obj, paths) {
  const out = {};
  for (const p of paths) {
    const parts = p.split('.');
    (function walk(src, dst, i) {
      if (src == null) return;
      const raw = parts[i];
      const arr = raw.endsWith('[]');
      const k = arr ? raw.slice(0, -2) : raw;
      if (!(k in Object(src))) return;
      const v = src[k];
      if (i === parts.length - 1) {
        dst[k] = arr && Array.isArray(v) ? v.slice() : v;
        return;
      }
      if (arr) {
        if (!Array.isArray(v)) return;
        dst[k] = dst[k] || v.map(() => ({}));
        v.forEach((item, j) => walk(item, dst[k][j], i + 1));
      } else {
        dst[k] = dst[k] || {};
        walk(v, dst[k], i + 1);
      }
    })(obj, out, 0);
  }
  return out;
}

/** The responses the director learns from, and the only fields it keeps. */
export const SNIFF_RULES = Object.freeze([
  { name: 'apply', method: 'POST', path: /\/marketplace\/api\/apply$/, fields: ['data.applicationId', 'data.activationCode'], secret: true },
  { name: 'credentials', method: 'POST', path: /\/marketplace\/api\/activate-credentials\//, fields: ['data.adminToken', 'data.employerNodeUrl'], secret: true },
  { name: 'import', method: 'POST', path: /^\/api\/import$/, fields: ['data.results[].employeeId', 'data.results[].tokenId', 'data.results[].tokenPIN', 'data.results[].status', 'data.success'], secret: true },
  { name: 'wallet', method: 'POST', path: /\/onboarding\/derive-wallet$/, fields: ['data.walletId'], secret: false },
  { name: 'attestation', method: 'POST', path: /\/attestation\/request$/, fields: ['data.v', 'data.t', 'data.w', 'data.cc', 'data.ls', 'data.fr', 'data.ts', 'data.exp', 'data.n', 'data.pk', 'data.sig'], secret: false }
]);

export class Sniffer {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.captures = new Map(); // name -> [{ at, status, value }]
    this.waiters = [];
  }

  watch(page, rules = SNIFF_RULES) {
    page.on('response', async (res) => {
      let url;
      try { url = new URL(res.url()); } catch { return; }
      const req = res.request();
      const rule = rules.find((r) => (!r.method || r.method === req.method()) && r.path.test(url.pathname));
      if (!rule) return;
      const ct = String(res.headers()['content-type'] || '');
      if (!ct.includes('json')) return;
      let body = null;
      try { body = await res.json(); } catch { return; }
      const value = pickPaths(body, rule.fields);
      const cap = { at: Date.now(), status: res.status(), value };
      if (!this.captures.has(rule.name)) this.captures.set(rule.name, []);
      this.captures.get(rule.name).push(cap);
      this.log(`heard ${rule.name} (${res.status()})${rule.secret ? ', kept in memory only' : ''}`);
      for (const w of this.waiters.slice()) {
        if (w.name === rule.name && cap.at >= w.since) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(cap);
        }
      }
    });
  }

  /** The newest capture of `name` at or after `since`, or one that arrives within `timeout`. */
  waitFor(name, { since = 0, timeout = 60000 } = {}) {
    const have = (this.captures.get(name) || []).filter((c) => c.at >= since);
    if (have.length) return Promise.resolve(have[have.length - 1]);
    return new Promise((resolve, reject) => {
      const w = { name, since, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`no ${name} response within ${Math.round(timeout / 1000)} s`));
        }
      }, timeout);
    });
  }

  last(name) {
    const list = this.captures.get(name) || [];
    return list[list.length - 1] || null;
  }
}
