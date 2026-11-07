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
 * `npm run tokens`: the dashboards of a local network and the token each one asks for, with the values from
 * `.zpk/local.env`. For this machine only; a production network's tokens are never printed.
 */
import { readLocalEnv } from './profile.js';
import { ENV_FILE } from './paths.js';
import { guideText } from './guide.js';

const env = readLocalEnv(ENV_FILE);
if (!env) {
  console.log('\n  No local profile yet: `npm run setup` (or `npm start`) makes one.\n');
  process.exit(1);
}
console.log(guideText(env, true));
