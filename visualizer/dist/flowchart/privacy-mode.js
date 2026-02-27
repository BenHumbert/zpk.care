/**
 * privacy-mode.js — Privacy mode toggle for the Network Topology Dashboard.
 *
 * When active ("Network View"), replaces all member PHI/PII with opaque
 * Poseidon wallet hashes — showing what the leviathan network actually sees.
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
   * Transform a member display label.
   * @param {string} name   Original display name (e.g. "Alice Johnson")
   * @param {number} index  Member index (0-7)
   * @param {string|null} walletId  Enrolled wallet ID string, or null if unenrolled
   * @returns {string}
   */
  function memberLabel(name, index, walletId) {
    if (!_active) return name;
    if (walletId) return 'W-' + truncHash(walletId, 6, 4);
    return 'Member M-' + index;
  }

  /**
   * Transform a member sublabel.
   * @param {string} sublabel  Original sublabel (e.g. "SELF", "SPOUSE")
   * @param {number} index     Member index
   * @param {string|null} walletId  Wallet ID if enrolled
   * @returns {string}
   */
  function memberSublabel(sublabel, index, walletId) {
    if (!_active) return sublabel;
    if (walletId) return truncHash(walletId, 8, 4);
    return 'Partition ' + (index % 3);
  }

  /**
   * Transform an actor or target name from a VizEvent for display.
   * Only member types are transformed; all others pass through unchanged.
   * @param {string} name  Display name
   * @param {string} type  Entity type (member, prescriber, pharmacy, insurer, etc.)
   * @param {object} data  Event data (may contain memberIndex, walletId)
   * @param {Array}  members  MEMBERS array for reverse lookup
   * @returns {string}
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
      return wid ? 'W-' + truncHash(wid, 6, 4) : 'Member (opaque)';
    }

    // All non-member types pass through unchanged
    return name;
  }

  return {
    isActive, toggle, onChange,
    memberLabel, memberSublabel, actorLabel,
  };
})();
