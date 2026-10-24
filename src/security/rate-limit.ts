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
 * A sliding-window rate limiter, keyed by whatever the caller wants to count: a remote address (as
 * addressKey below writes it), a token ID, or a single shared key for a route-wide ceiling. No
 * dependencies, so any listener can use it. Memory is bounded by evicting keys whose window has gone
 * quiet.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  /**
   * @param max — how many events a key may have inside one window
   * @param windowMs — the window's length
   */
  constructor(private readonly max: number, private readonly windowMs: number) {
    if (!(max > 0) || !(windowMs > 0)) throw new Error('SlidingWindowLimiter: max and windowMs must be positive');
  }

  /** Record an event for `key` if it is allowed; returns false when the key is over its limit. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let times = this.hits.get(key);
    if (!times) {
      times = [];
      this.hits.set(key, times);
    }
    while (times.length > 0 && times[0] <= cutoff) times.shift();
    if (times.length >= this.max) return false;
    times.push(now);
    if (this.hits.size > 10_000) this.evict(cutoff);
    return true;
  }

  /** How many events `key` has inside the current window. */
  count(key: string, now: number = Date.now()): number {
    const times = this.hits.get(key);
    if (!times) return 0;
    const cutoff = now - this.windowMs;
    return times.filter((t) => t > cutoff).length;
  }

  private evict(cutoff: number): void {
    for (const [k, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) this.hits.delete(k);
    }
  }
}

/** A dotted-quad IPv4 address, each part 0 to 255 with no leading zero, as a socket reports one. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The interface after a link-local address's '%', as Node.js reports it: a name (fe80::1%eth0) or a number (%12). */
const ZONE = /^[0-9A-Za-z._~-]+$/;

/** The key of every link-local caller, ahead of the interface it arrived on: the prefix every host on a link shares. */
const LINK_LOCAL_KEY = 'fe80::/64';

/**
 * The key a per-caller limit counts a request under, from the caller's address (the review of A-89): its socket's
 * remote address, or the client a reverse proxy the listener trusts names for it (clientAddress, network-policy.ts).
 *
 * An IPv4 address is its own key, as written. An IPv4-mapped IPv6 address (::ffff:a.b.c.d, as a listener bound to both
 * families reports an IPv4 caller) is the IPv4 address it maps, so a caller is one key however the listener is bound.
 * A link-local IPv6 address (fe80::/10) is keyed as fe80::/64 on the interface it arrived on, written fe80::/64%eth0,
 * or fe80::/64 alone when the address names no interface: one key for each of this host's links. Any other IPv6 address
 * is its /64 network, written as the first four groups of the expanded address followed by ::/64: one host commonly
 * holds a whole /64 (a mobile network gives each phone one, as many hosting providers give each server) and may use any
 * address in it, so keyed by the full address one host would be as many callers as it chose. Anything else, or no
 * address, is 'unknown', one key for all of it.
 *
 * The link is the narrowest key a link-local caller has. Every host on a link shares fe80::/64, and any of them can
 * take as many link-local addresses as it likes, since nothing assigns them, so keyed by the whole address one
 * neighbour was as many callers as it chose (the review of the trusted-proxy fix). Keyed by fe80::/64 alone, as the /64
 * rule keys it, every link-local caller on every link was one, and one of them could spend the allowance of all (the
 * review of the /64 rule). So the interface stays in the key: fe80::1, which many routers give themselves, seen on two
 * interfaces is two hosts, and the interface is this host's to name, not the caller's to choose, so keeping it splits
 * callers only across this host's own links. The hosts on one link share one allowance, as the clients of an untrusted
 * proxy do. An address elsewhere in fe80::/10, which RFC 4291 does not form but a host can still take, comes over the
 * same link and is keyed the same.
 *
 * It counts where a request comes from, not who sends it: a reverse proxy the listener does not trust is one source
 * for everyone behind it, and a client with many sources (a swarm of IPv4 addresses, or of /64s) gets a source's
 * allowance from each, which is the general rate limit's to answer (A-80). No dependencies, like the limiter.
 */
export function addressKey(remote: string | undefined): string {
  const address = parseAddress(remote);
  if (!address) return 'unknown';
  if ('v4' in address) return address.v4;
  if (isLinkLocal(address.v6)) return address.zone === null ? LINK_LOCAL_KEY : `${LINK_LOCAL_KEY}%${address.zone}`;
  return address.v6.slice(0, 4).map((g) => g.toString(16)).join(':') + '::/64';
}

/**
 * An IP address written one way, or null when `text` is not one: an IPv4 address as written; an IPv4-mapped IPv6
 * address as the IPv4 address it maps; any other IPv6 address as RFC 5952 writes it (lower case, no leading zeros, the
 * longest run of zero groups as ::), with the interface after its '%' kept on a link-local address and dropped from any
 * other, where it means nothing. Two texts of one address are equal once normalized, which is how a listener knows a
 * trusted proxy's socket (network-policy.ts).
 */
export function normalizeAddress(text: string | undefined): string | null {
  const address = parseAddress(text);
  if (!address) return null;
  if ('v4' in address) return address.v4;
  return ipv6Text(address.v6, isLinkLocal(address.v6) ? address.zone : null);
}

/** An address as read: IPv4 (written so, or IPv4-mapped), or the eight groups of an IPv6 address and its interface. */
type ParsedAddress = { v4: string } | { v6: number[]; zone: string | null };

function parseAddress(text: string | undefined): ParsedAddress | null {
  if (typeof text !== 'string') return null;
  if (IPV4.test(text)) return { v4: text };
  // A link-local address carries its interface after a '%' (fe80::1%eth0), as Node.js reports one; that is not part of
  // the address.
  const at = text.indexOf('%');
  const zone = at === -1 ? null : text.slice(at + 1);
  if (zone !== null && !ZONE.test(zone)) return null;
  const groups = ipv6Groups(at === -1 ? text : text.slice(0, at));
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return { v4: [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.') };
  }
  return { v6: groups, zone };
}

/** Whether an IPv6 address is link-local: fe80::/10. */
function isLinkLocal(groups: number[]): boolean {
  return (groups[0] & 0xffc0) === 0xfe80;
}

/** An IPv6 address as RFC 5952 writes it (section 4), followed by '%' and `zone` when one is given. */
function ipv6Text(groups: number[], zone: string | null): string {
  // The longest run of two or more zero groups, the first of runs as long, is written '::'.
  let start = -1;
  let length = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > length) {
      start = i;
      length = j - i;
    }
    i = j === i ? i + 1 : j;
  }
  const hex = groups.map((g) => g.toString(16));
  const text = start === -1
    ? hex.join(':')
    : `${hex.slice(0, start).join(':')}::${hex.slice(start + length).join(':')}`;
  return zone === null ? text : `${text}%${zone}`;
}

/** The eight 16-bit groups of an IPv6 address without its zone, in any text form (RFC 4291, section 2.2); else null. */
function ipv6Groups(text: string): number[] | null {
  let s = text.toLowerCase();
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return null;
  // A dotted quad at the end (::ffff:192.0.2.1) is the last two groups.
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!IPV4.test(tail)) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    s = s.slice(0, lastColon + 1) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === '') return [];
    const out: number[] = [];
    for (const part of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // '::' stands for one or more groups of zeros.
  const zeros = 8 - head.length - rest.length;
  return zeros >= 1 ? [...head, ...new Array<number>(zeros).fill(0), ...rest] : null;
}
