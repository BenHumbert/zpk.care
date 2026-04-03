# XSS False Positives Log

## XSS-VULN-02: Legacy Dashboard Zero-Escaping Pattern (dashboard/app.js)
- **Status:** NOT IN EXPLOITATION QUEUE — analysis marked `externally_exploitable: false`
- **Reason:** `dashboard/app.js` is not served in the current deployment. `start-leviathan.ts` configures `dashboard-leviathan/` instead. No external path serves this file.
- **Testing attempted:** Confirmed via reconnaissance that only `dashboard-leviathan/` is served on port 3030. No endpoint serves `dashboard/app.js`.
- **Verdict:** FALSE POSITIVE for current deployment — would become EXPLOITED if deployment config changed.

## XSS-VULN-03: Explorer Receipt ID onclick JS-String Injection (esc() missing quote escaping)
- **Status:** NOT IN EXPLOITATION QUEUE — analysis marked medium confidence, injection path unclear
- **Reason:** Receipt IDs are server-generated Poseidon/SHA-256 hashes. No confirmed external API path to inject a custom receipt ID containing `');alert(1)//`.
- **Testing attempted:** Analysis confirmed no API allows setting custom receipt IDs. `l2_recordFill` failed with server error.
- **Verdict:** FALSE POSITIVE for current deployment — vulnerable code pattern but no attacker-controllable injection path.

## XSS-VULN-04: Explorer Batch Number onclick JS Injection (no escaping on `num`)
- **Status:** NOT IN EXPLOITATION QUEUE — analysis marked low confidence
- **Reason:** Batch numbers are sequential integers generated server-side. No API allows setting arbitrary batch number strings.
- **Testing attempted:** Batch numbers confirmed to be auto-incremented integers. No external injection path for `0);alert(1)//`.
- **Verdict:** FALSE POSITIVE for current deployment — vulnerable code sink but no attacker-controllable source.

## XSS-VULN-05: Batch/Receipt Status Fields Unescaped in dashboard-leviathan
- **Status:** NOT IN EXPLOITATION QUEUE — analysis marked low confidence
- **Reason:** `b.status` values are server state-machine strings (pending/settling/settled/failed). No external API allows setting arbitrary HTML as batch status.
- **Verdict:** FALSE POSITIVE for current deployment.
