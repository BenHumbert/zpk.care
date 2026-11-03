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
 * Every suite reads the frozen catalog in tests/fixtures/data, not the live one in src/data (A-134).
 *
 * The live catalog follows CMS, which publishes new NADAC rates every week, and the suites pin prices and catalog
 * positions; reading it made every import a round of re-pinning. Every data loader honours ZKP_DATA_DIR, so pointing it
 * here before any suite loads is enough. A run that sets ZKP_DATA_DIR itself keeps its own.
 *
 * To move the tests to newer data on purpose, copy src/data's formulary.json, formulary-100.json, pharmacies.json and
 * prescribers.json here and re-pin what changes, as one reviewed change.
 */
import path from 'path';

process.env.ZKP_DATA_DIR ??= path.resolve(__dirname, '..', 'fixtures', 'data');
