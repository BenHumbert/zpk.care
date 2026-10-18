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
 * One way to load the console's state — plan item B1, first half.
 *
 * `GET /interactive/state` is the sequencer's admin-gated view of enrolled members, prescriptions
 * and fills (the operator token is attached by operator-auth.js). The fixture people the console
 * displays are not part of that any more: they are a static file served beside this page by the
 * explorer, `/fixtures.json`, fetched once. The two are merged here into the `demoData` shape every
 * screen already reads, so the screens did not have to change.
 */

let fixturesPromise = null;

async function loadFixtures() {
  if (!fixturesPromise) {
    fixturesPromise = fetch('/fixtures.json')
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        if (!data) fixturesPromise = null;   // try again next time; the page still renders without people
        return data || { members: [], prescribers: [], pharmacies: [] };
      });
  }
  return fixturesPromise;
}

/**
 * Fetch the interactive state and attach the fixture directory to it.
 * Returns null when the state could not be read (not yet compiled, no token, server down).
 */
export async function loadInteractiveState(apiBase) {
  let res;
  try {
    res = await fetch(`${apiBase}/interactive/state`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const state = await res.json();
  const fixtures = await loadFixtures();
  state.demoData = {
    ...(state.demoData || {}),
    members: fixtures.members,
    prescribers: fixtures.prescribers,
    pharmacies: fixtures.pharmacies,
  };
  return state;
}
