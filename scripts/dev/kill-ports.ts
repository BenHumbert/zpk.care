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
 * `npm run kill:ports`: free this project's ports by stopping this checkout's own processes (A-133).
 *
 * Any other program on one of the ports is named, with its process ID, and left running. The explorer's port is the
 * one ZKTRIDENT_EXPLORER_PORT names (8000 by default). Workers and the harness hold no port; scripts/dev/kill-zpk.ps1
 * stops those too.
 *
 * Usage:
 *   npm run kill:ports
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { freeProjectPorts } from './kill-ports-lib.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
freeProjectPorts(process.env, repoRoot, (line) => console.log(line));
console.log('Done.');
