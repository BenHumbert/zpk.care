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
 * `npm run setup`: make this machine ready to run the whole network on its own (prepare.ts says what it checks and
 * writes).
 *
 *   npm run setup                    check the machine; write .zpk/local.env and the samples if they are missing
 *   npm run setup -- --new-secrets   make new secrets (signs out every dashboard and voids earlier attestations)
 */
import { setup } from './prepare.js';

setup(process.argv.slice(2)).then((ok) => process.exit(ok ? 0 : 1));
