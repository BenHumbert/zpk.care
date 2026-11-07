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
 * `npm stop`: stop a local network that is still running, from any terminal. Only this checkout's own processes are
 * stopped (scripts/dev/kill-ports-lib.ts); a program of anyone else's on one of the ports is named and left alone.
 */
import { freeProjectPorts } from '../dev/kill-ports-lib.js';
import { readLocalEnv } from './profile.js';
import { ENV_FILE, ROOT } from './paths.js';

freeProjectPorts({ ...(readLocalEnv(ENV_FILE) ?? {}), ...process.env }, ROOT, (line) => console.log(line));
