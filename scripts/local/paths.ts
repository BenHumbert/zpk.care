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
 * Where the local profile keeps its files (profile.ts says what each holds). Apart from the modules the suites import,
 * since it reads import.meta, which the suites (compiled as CommonJS) cannot.
 */
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCAL_DIR = path.join(ROOT, '.zpk');
export const ENV_FILE = path.join(LOCAL_DIR, 'local.env');
export const SAMPLES_DIR = path.join(LOCAL_DIR, 'samples');
export const LOGS_DIR = path.join(LOCAL_DIR, 'logs');
export const HR_TOOL_DIR = path.join(LOCAL_DIR, 'hr-tool');
