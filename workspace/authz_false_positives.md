# Authorization False Positives Tracking

No false positives identified. All vulnerabilities from the queue were either:
- Confirmed EXPLOITED (AUTHZ-VULN-01 through AUTHZ-VULN-13)
- Classified POTENTIAL due to external operational constraints (AUTHZ-VULN-14, AUTHZ-VULN-15)

## Notes on Near-False-Positives

### AUTHZ-VULN-07 (Horizontal PHI Exposure)
Initially appeared to be a false positive because test wallets returned "Member not enrolled" errors. However, the check is a BUSINESS LOGIC check (enrollment status), not an authentication check. Once enrolled wallet IDs were obtained (via /node/state, which itself leaks PII), the endpoint exposed full PHI. Classified as EXPLOITED.

### AUTHZ-VULN-15 (Admin Key Genesis)
The blocking mechanism at line 774 (`if (!genesisKey && !this.options.unsecureMode)`) is a security implementation designed to prevent arbitrary genesis registration in secure mode. However, the vulnerability exists in the code and would be exploitable if `unsecureMode=true` were configured. Classified as POTENTIAL (not false positive) because the blocker is a deployment configuration parameter, not a fundamental security control.
