# Auth Exploitation False Positives

No false positives identified. All vulnerabilities in the queue were either:
- EXPLOITED (AUTH-VULN-01, -02, -03, -04, -05, -06)
- POTENTIAL with HIGH confidence due to external deployment constraints, not security controls (AUTH-VULN-07, -08)

Note: AUTH-VULN-07 and AUTH-VULN-08 are classified POTENTIAL rather than FALSE_POSITIVE because:
- The preventing factor is an external configuration constraint (admin tokens not configured on entity nodes), NOT a security implementation designed to stop these specific attacks
- The vulnerable code paths are confirmed in source code
- The attacks would be straightforwardly exploitable if tokens were configured
