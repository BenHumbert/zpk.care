/**
 * Command-line arguments for the demo tools (adapted from SwapStreet's testnet/lib/kit.mjs parseArgs).
 *
 *   --flag            -> { flag: true }
 *   --key value       -> { key: 'value' }
 *   --key=value       -> { key: 'value' }      (split at the FIRST '=', so --voices=a=b,c=d keeps its value)
 *   anything else     -> pushed onto _
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) out[k] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** "narrator=maya:narrator,hr=kokoro:af_sarah" -> { narrator: 'maya:narrator', hr: 'kokoro:af_sarah' }. */
export function parseVoices(spec) {
  const out = {};
  for (const kv of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new Error(`--voices: "${kv}" is not role=engine:voice`);
    out[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return out;
}

/** A folder-safe timestamp: 2026-10-19T03-12-44. */
export const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
