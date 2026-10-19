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
 * The fixture directory — plan item B1, first half (finding A-13's residue).
 *
 * The visualizer shows the fixture people on purpose: it is how the tool demonstrates what stays
 * on the device. Until this change those records travelled inside `GET /interactive/state`, the
 * sequencer's admin-gated dump of every enrolled member, which made the privileged payload carry
 * person records that have nothing to do with any member and left the visualizer blank without an
 * operator credential. They are a static import, so they are served as a static file instead, by
 * the explorer that serves the visualizer's own pages, and the dump stops carrying person records.
 *
 * Nothing here is runtime state. The formulary's live flags (active, current tier and copay) and
 * the plan block remain with the engine, because they are its state and carry no identity.
 */
import { MEMBERS, PRESCRIBERS, PHARMACIES, prescriberDisplayName } from './index.js';

export interface FixtureMember {
  index: number;
  firstName: string;
  lastName: string;
  cardholderId: string;
  dateOfBirth: string;
  relationship: string;
  employeeId: string;
  familyId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  genderCode: number;
}

export interface FixturePrescriber {
  index: number;
  firstName: string;
  lastName: string;
  name: string;
  credential: string;
  specialty: string;
  npi: string;
  state: string;
  deaNumber: string;
}

export interface FixturePharmacy {
  index: number;
  storeName: string;
  chain: string;
  pharmacyType: string;
  npi: string;
  ncpdpId: string;
  address: string;
  city: string;
  state: string;
  phone: string;
}

export interface FixtureDirectory {
  members: FixtureMember[];
  prescribers: FixturePrescriber[];
  pharmacies: FixturePharmacy[];
}

/**
 * The same projection the engine used to embed, moved here so the visualizer's reads still fit. One change since:
 * `name` carries "Dr." only for a physician (MD, DO), because the fixture prescribers include nurse practitioners
 * and a physician assistant.
 */
export function fixtureDirectory(): FixtureDirectory {
  return {
    members: MEMBERS.map((m, i) => ({
      index: i,
      firstName: m.localData.firstName,
      lastName: m.localData.lastName,
      cardholderId: m.localData.cardholderId,
      dateOfBirth: m.localData.dateOfBirth,
      relationship: m.relationship,
      employeeId: m.employeeId,
      familyId: m.familyId,
      address: m.address,
      city: m.city,
      state: m.state,
      zip: m.zip,
      genderCode: m.localData.genderCode,
    })),
    prescribers: PRESCRIBERS.map((p, i) => ({
      index: i,
      firstName: p.firstName,
      lastName: p.lastName,
      name: prescriberDisplayName(p),
      credential: p.credential,
      specialty: p.specialty,
      npi: p.localData.prescriberId,
      state: p.state,
      deaNumber: p.deaNumber,
    })),
    pharmacies: PHARMACIES.map((p, i) => ({
      index: i,
      storeName: p.storeName,
      chain: p.chain,
      pharmacyType: p.pharmacyTypeDesc,
      npi: p.localData.serviceProviderId,
      ncpdpId: p.ncpdpProviderId,
      address: p.address,
      city: p.city,
      state: p.state,
      phone: p.phone,
    })),
  };
}
