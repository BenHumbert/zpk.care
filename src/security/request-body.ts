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
 * One body read per request — plan item A9 (remainder).
 *
 * A signed request's signature covers the body, so the admin gate has to read the body before the
 * handler runs; a Node request stream can be read once. The first reader buffers the body and keeps
 * the promise on the request object, and every later reader gets the same bytes. The size limit is
 * the first reader's, which on every server here is the gate's.
 */
import type { IncomingMessage } from 'http';

const BODY = Symbol.for('zpk.care/request-body');

type WithBody = IncomingMessage & { [BODY]?: Promise<string> };

export function readRequestBody(req: IncomingMessage, maxBytes: number = Number.POSITIVE_INFINITY): Promise<string> {
  const carrier = req as WithBody;
  const cached = carrier[BODY];
  if (cached) return cached;
  const pending = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
  // A rejected read must not poison a later reader with an unhandled rejection; the reader that
  // awaits it sees the error.
  pending.catch(() => {});
  carrier[BODY] = pending;
  return pending;
}

/** The body already read for this request, if any reader has run. */
export function cachedRequestBody(req: IncomingMessage): Promise<string> | undefined {
  return (req as WithBody)[BODY];
}
