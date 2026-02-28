/**
 * privacy-mode.js — Privacy mode toggle for the Network Topology Dashboard.
 *
 * When active ("Network View"), replaces all member PHI/PII with opaque
 * Poseidon wallet hashes — showing what the leviathan network actually sees.
 *
 * Wallet IDs are displayed across 3 lines on the node for readability:
 *   line 1: first 8 digits
 *   line 2: middle 8 digits
 *   line 3: last 8 digits
 *
 * Prescribers, pharmacies, insurer, employer, and leviathans remain fully
 * visible. Only member identity is redacted.
 */

const PrivacyMode = (() => {
  const STORAGE_KEY = 'zkpcare-privacy-mode';
  let _active = localStorage.getItem(STORAGE_KEY) === 'true';
  const _callbacks = [];

  function isActive() { return _active; }

  function toggle() {
    _active = !_active;
    localStorage.setItem(STORAGE_KEY, String(_active));
    _callbacks.forEach(cb => cb(_active));
  }

  function onChange(cb) { _callbacks.push(cb); }

  /**
   * Split a wallet ID into 3 compact lines for node display.
   * Returns [line1, line2, line3].
   */
  function walletLines(walletId) {
    if (!walletId) return null;
    const s = String(walletId);
    if (s.length <= 16) return [s, '', ''];
    // Show first 8, middle 8, last 8 — enough to be unique
    const first = s.slice(0, 8);
    const mid = s.length > 24
      ? s.slice(Math.floor(s.length / 2) - 4, Math.floor(s.length / 2) + 4)
      : s.slice(8, 16);
    const last = s.slice(-8);
    return [first, mid, last];
  }

  /**
   * Transform a member display label (line 1 on node).
   * Privacy on + enrolled: first 8 digits of wallet hash.
   * Privacy on + unenrolled: generic opaque marker.
   */
  function memberLabel(name, index, walletId) {
    if (!_active) return name;
    if (walletId) {
      const lines = walletLines(walletId);
      return lines[0];
    }
    return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // ••••••••
  }

  /**
   * Transform a member sublabel (line 2 on node).
   * Privacy on + enrolled: middle 8 digits of wallet hash.
   * Privacy on + unenrolled: opaque partition hint.
   */
  function memberSublabel(sublabel, index, walletId) {
    if (!_active) return sublabel;
    if (walletId) {
      const lines = walletLines(walletId);
      return lines[1];
    }
    return 'Partition ' + (index % 3);
  }

  /**
   * Third line for node display (line 3).
   * Privacy on + enrolled: last 8 digits of wallet hash.
   * Returns null when not applicable.
   */
  function memberLine3(walletId) {
    if (!_active) return null;
    if (walletId) {
      const lines = walletLines(walletId);
      return lines[2];
    }
    return null;
  }

  /**
   * Transform an actor or target name from a VizEvent for display.
   * Only member types are transformed; all others pass through unchanged.
   */
  function actorLabel(name, type, data, members) {
    if (!_active) return name;
    if (!name) return name;

    if (type === 'member') {
      const idx = data?.memberIndex;
      const wid = data?.walletId || data?.actorWalletId || data?.targetWalletId;
      if (idx != null) return memberLabel(name, idx, wid);
      // Reverse lookup from MEMBERS array
      if (members) {
        const m = members.find(m => m.name.toLowerCase() === name.toLowerCase());
        if (m) return memberLabel(name, m.idx, wid);
        // Partial match
        const partial = members.find(m =>
          name.toLowerCase().includes(m.name.toLowerCase()) ||
          m.name.toLowerCase().includes(name.toLowerCase())
        );
        if (partial) return memberLabel(name, partial.idx, wid);
      }
      return wid ? walletLines(wid)[0] : '\u2022\u2022\u2022\u2022';
    }

    // All non-member types pass through unchanged
    return name;
  }

  return {
    isActive, toggle, onChange,
    memberLabel, memberSublabel, memberLine3, actorLabel,
  };
})();
