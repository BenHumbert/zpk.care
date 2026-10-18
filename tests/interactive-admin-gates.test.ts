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
 * Admin gates on the engine's interactive routes — the acceptance test for phase A item A11,
 * findings A-13, A-19 and ENG-11.
 *
 * Three things were open that should never have been:
 *
 *   - `GET /interactive/state`, measured at 137,035 bytes on a live run: every enrolled member's
 *     wallet ID beside their display name, employee ID and family ID, their accumulators, their
 *     portable credential JSON and attestations, prescriptions linking a wallet to a drug, and
 *     the fixture members' names, cardholder IDs, dates of birth and home addresses. One
 *     unauthenticated GET returned all of it (A-13).
 *   - `POST /interactive/update-provider-network`, a per-member cascade that rewrites every
 *     member's eligibility and submits a proof for each. Its sibling `update-formulary` was
 *     already gated, which is what made the omission visible (A-19).
 *   - The batch and checkpoint controls. The e2e harness asserts `force-batch` should be refused
 *     unauthenticated and got a 200 on a live run (ENG-11).
 *
 * This reads the registration table rather than making requests, because the question is which
 * routes carry the admin flag. A route that loses the flag fails here without anyone having to
 * think of probing it, which is the regression that matters: these gates are one entry in a Set
 * away from disappearing.
 */
import fs from 'fs';

const ROUTES_FILE = 'src/adjudication/interactive-routes.ts';

/** The ADMIN_ROUTES set, read out of the source. */
function adminRouteSet(src: string): Set<string> {
  const start = src.indexOf('const ADMIN_ROUTES = new Set([');
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf(']);', start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  return new Set(
    [...block.matchAll(/'(\/interactive\/[a-z-]+)'/g)].map((m) => m[1]),
  );
}

/** Every path registered through the `reg` helper in this file. */
function registeredPaths(src: string): Array<{ method: string; path: string }> {
  return [...src.matchAll(/reg\('([A-Z]+)',\s*'(\/interactive\/[^']+)'/g)]
    .map((m) => ({ method: m[1], path: m[2] }));
}

describe('the routes A11 closes are admin-gated', () => {
  let src: string;
  let admin: Set<string>;

  beforeAll(() => {
    src = fs.readFileSync(ROUTES_FILE, 'utf-8');
    admin = adminRouteSet(src);
  });

  test('the identity dump requires admin', () => {
    expect(admin.has('/interactive/state')).toBe(true);
  });

  test('the provider-network cascade requires admin', () => {
    expect(admin.has('/interactive/update-provider-network')).toBe(true);
  });

  test.each([
    '/interactive/force-batch',
    '/interactive/save-checkpoint',
    '/interactive/retry-batch',
    '/interactive/simulate-batch-failure',
  ])('the ledger control %s requires admin', (route) => {
    expect(admin.has(route)).toBe(true);
  });

  /*
   * A12 fixed the bug that was accidentally blocking credential minting, so these two had to be
   * closed in the same change. A-17's own note said to treat it as critical the moment A-24 was
   * fixed; this is the test that keeps it closed.
   */
  test.each([
    '/interactive/generate-credential',
    '/interactive/credential-status',
  ])('credential minting route %s requires admin', (route) => {
    expect(admin.has(route)).toBe(true);
  });

  test('the gates that were already there are still there', () => {
    for (const route of [
      '/interactive/approve-prior-auth',
      '/interactive/deny-prior-auth',
      '/interactive/terminate-member',
      '/interactive/terminate-group',
      '/interactive/decrypt-thread',
      '/interactive/create-delegation',
      '/interactive/update-formulary',
      '/interactive/plan-year-rollover',
      '/interactive/reset',
    ]) {
      expect(admin.has(route)).toBe(true);
    }
  });

  test('every path in the admin set is actually a route this file registers', () => {
    // A typo in the Set is silent: it gates nothing and nothing complains. This catches that.
    const registered = new Set(registeredPaths(src).map((r) => r.path));
    const orphans = [...admin].filter((p) => !registered.has(p));
    expect(orphans).toEqual([]);
  });

  test('the gating helper applies the flag, so membership in the set is sufficient', () => {
    // If this helper stops consulting ADMIN_ROUTES, every assertion above becomes decorative.
    expect(src).toContain("ADMIN_ROUTES.has(path) ? { adminOnly: true } : walletSigned ? { walletSigned } : undefined");
  });
});

describe('the routes that stay open are the ones a dashboard polls', () => {
  let src: string;
  let admin: Set<string>;

  beforeAll(() => {
    src = fs.readFileSync(ROUTES_FILE, 'utf-8');
    admin = adminRouteSet(src);
  });

  test('the console stream stays open, because it carries no member data', () => {
    // Deliberately not gated: it is a log tail for the operator console.
    expect(admin.has('/interactive/console')).toBe(false);
  });

  test('a meaningful number of routes are gated, so the set has not been emptied', () => {
    expect(admin.size).toBeGreaterThanOrEqual(15);
  });
});

describe('the harness probes the dump unauthenticated on purpose', () => {
  test('the PHI sweep in run.ts still uses the bare client', () => {
    // A11 switched the harness bookkeeping reads to an admin client. The sweep must NOT follow,
    // or it would stop measuring what an outsider can collect and would silently start passing.
    const run = fs.readFileSync('scripts/e2e-verify/run.ts', 'utf-8');
    const sweepLine = run
      .split('\n')
      .find((l) => l.includes("sources.push(['sequencer /interactive/state'"));
    expect(sweepLine).toBeDefined();
    expect(sweepLine).toContain("http('GET'");
    expect(sweepLine).not.toContain('httpAdmin');
  });

  test('the containment check also probes it without credentials', () => {
    const check = fs.readFileSync('scripts/e2e-verify/check-phi-containment.ts', 'utf-8');
    expect(check).toContain('GET /interactive/state');
  });
});
