/**
 * Secrets off camera, by design. Each person's context gets these styles on every page it loads (an init script),
 * before the dashboard draws anything:
 *  - token, PIN and passphrase inputs are masked (-webkit-text-security: disc), even where the dashboard made the
 *    input type=text (the insurer token, the enrollment code, the SMS PIN)
 *  - the employer admin token printed once at activation, the codes and PINs in the HR Tool, and the two recovery
 *    cards on the phone are redacted: their text is not drawn at all (transparent), only a hatched bar shows
 *  - the identity fields the member types on the phone are blurred (the person is fictional; the blur says the
 *    values stay on the phone)
 * The values themselves never reach the screen another way either: the director writes secrets with page.evaluate
 * (stage.fillSecret) or storageState, never as key presses.
 */
const MASK = '-webkit-text-security:disc!important;';
const REDACT = 'color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;user-select:none!important;'
  + 'background:repeating-linear-gradient(135deg,rgba(100,116,139,.55) 0 6px,rgba(148,163,184,.35) 6px 12px)!important;border-radius:4px!important;';
const BLUR = 'filter:blur(6px)!important;';

export const MASKS = Object.freeze({
  insurer: `#admin-token-input{${MASK}}`,
  marketplace: `#activate-content code{${REDACT}} #sign-appid{${MASK}}`,
  employer: `#admin-token-input{${MASK}}`,
  hrtool: `#setup-token,#setup-passphrase,#setup-confirm,#unlock-passphrase,#reveal-passphrase{${MASK}}`
    + ` #csv-results-panel .table-wrap td,#codes-table td,#pins-table td{${REDACT}}`,
  member: `#ob-pin,#ob-pin-confirm,#ob-token,#ob-enroll-pin,#ob-recovery-pin,#restore-pin,#backup-pin,#backup-pin-confirm{${MASK}}`
    + ` #ob-cid,#ob-fn,#ob-ln,#ob-dob{${BLUR}}`
    // renderRecoveryCards: the yellow box; each card is a 'margin:6px 0' block holding its id line and its JSON
    + ` #onboard-body div[style*="var(--yellow)"] div[style*="margin:6px 0"] > div{${REDACT}}`
    + ` #restore-json{${BLUR}}`,
  prescriber: '',
  pharmacy: '',
  network: `#admin-token-input{${MASK}}`
});

/** The init script that installs a style sheet as soon as the document has a head or body. */
export function maskScript(css) {
  if (!css) return;
  const add = () => {
    if (document.getElementById('__zpkMasks')) return true;
    const root = document.head || document.body || document.documentElement;
    if (!root) return false;
    const st = document.createElement('style');
    st.id = '__zpkMasks';
    st.textContent = css;
    root.appendChild(st);
    return true;
  };
  if (add()) return;
  // the init script can run before the document element exists: add the sheet the moment it does
  const mo = new MutationObserver(() => { if (add()) mo.disconnect(); });
  mo.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { add(); mo.disconnect(); }, { once: true });
}

/**
 * Installs the masks for the named dashboards on a context, and the take's page zoom: every page is a 1920x1080
 * viewport drawn at html { zoom: 1.5 }, so it lays out as on a 1280x720 screen and records crisp at 1080p
 * (lib/whiteboard.mjs SCREEN explains why a deviceScaleFactor does not do this).
 */
export async function applyMasks(context, names, { zoom = 1.5 } = {}) {
  const css = [zoom && zoom !== 1 ? `html{zoom:${zoom}!important}` : '', ...names.map((n) => MASKS[n] || '')].filter(Boolean).join('\n');
  if (css) await context.addInitScript(maskScript, css);
  return css;
}
