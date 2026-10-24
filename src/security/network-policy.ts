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
 * One place for who may reach a listener and from where — phase A item A2.
 *
 * Fourteen listeners used to decide this each for themselves, with four different answers:
 * eleven bound every interface, seven defaulted to a CORS wildcard, one defaulted to a list
 * that could never match a browser because it carried no ports, and eighty-one route handlers
 * overrode whichever policy the server had set by naming the header again themselves.
 *
 * The off-list case was the one that looked safe and was not. A disallowed origin used to be
 * answered with the literal string `null`, and `Access-Control-Allow-Origin: null` is a grant,
 * not a denial: it admits every null-origin context — a `file://` page, a sandboxed iframe, a
 * data URI. Hence `corsOriginHeader` returning null to mean *send no header*.
 *
 * Scope: loopback binding is the right answer for one host and the wrong one for the ten-node
 * cluster, which needs mutual TLS between known peers instead. That is phase E, and it replaces
 * this rather than extending it.
 */
import type { IncomingMessage } from 'http';
import { normalizeAddress } from './rate-limit.js';

/** Hosts a browser on this machine will present as an origin. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1'] as const;

/**
 * Ports this deployment serves a dashboard or an API on.
 *
 * Employer nodes are absent on purpose: the orchestrator spawns them on an ephemeral port
 * (`listen(0)`), so their port is not knowable here. Their dashboards are served by the node
 * itself and are therefore same-origin, which needs no CORS grant. An employer page that
 * needed to call another service cross-origin would have to be given its origin explicitly
 * through `ZKTRIDENT_CORS_ORIGINS`.
 */
const LOCAL_PORTS = [3030, 3031, 3032, 4001, 4002, 4003, 4004, 4040, 8000] as const;

/**
 * Resolve the address a listener binds to. **Loopback by default**, which is the change:
 * every server previously defaulted to `0.0.0.0`, so a member's device and every provider
 * node answered to the whole local network.
 *
 * `ZKTRIDENT_HOST` still overrides, for a deployment that genuinely serves an interface,
 * but binding beyond loopback now says so at boot rather than passing unremarked.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv, role: string): string {
  const host = env.ZKTRIDENT_HOST ?? '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') {
    console.warn(
      '  [net] %s is bound to %s, reachable from the whole network. Set ZKTRIDENT_HOST to ' +
        '127.0.0.1 unless this host is meant to serve other machines, and name the host they ' +
        'reach it by in ZKTRIDENT_PUBLIC_HOSTS: beyond loopback it answers no other Host.',
      role, host,
    );
  }
  return host;
}

/**
 * Resolve the browser origins a server will answer cross-origin.
 *
 * The default is every local dashboard origin, written out with ports. The previous default
 * of `['http://localhost', 'http://127.0.0.1']` matched nothing, because a browser sends
 * `http://localhost:4001`, so the policy denied every browser and one endpoint had to opt
 * out with a wildcard to work at all.
 */
export function resolveAllowedOrigins(
  env: NodeJS.ProcessEnv,
  opts: { role: string; allowWildcard?: boolean } = { role: 'server' },
): string[] {
  const configured = env.ZKTRIDENT_CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);

  if (configured?.includes('*')) {
    if (!opts.allowWildcard) {
      console.warn(
        '  [net] %s: a CORS wildcard was requested but is not permitted here. Falling back ' +
          'to the local dashboard origins.',
        opts.role,
      );
    } else {
      console.warn(
        '  [net] %s: CORS is open to ANY origin. Any page the user visits can call this ' +
          'server and read the response. Local use only.',
        opts.role,
      );
      return ['*'];
    }
  } else if (configured?.length) {
    return configured;
  }

  return LOCAL_HOSTS.flatMap((h) => LOCAL_PORTS.map((p) => `http://${h}:${p}`));
}

/**
 * Whether to send an `Access-Control-Allow-Origin` header, and what to put in it.
 *
 * Returns null when no header should be sent at all. That matters for two cases the old
 * code got wrong: a request with no `Origin` (curl, a server, a same-origin navigation) has
 * no CORS to grant, and a disallowed origin was being answered with the literal `null`,
 * which grants access to any null-origin context such as a sandboxed iframe or a `file://`
 * page. Omitting the header denies instead.
 */
export function corsOriginHeader(origin: string | undefined, allowed: string[]): string | null {
  if (allowed.includes('*')) return '*';
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}

/*
 * ── What every listener checks before it routes ──────────────────────────────────────────
 *
 * Finding A-82, from the security posture check of 2026-10-24: no listener looked at the Host
 * header, every one read a POST body as JSON whatever type it declared, and the pages a node or
 * the explorer serves could be framed by any site.
 *
 * The Host header. A loopback bind keeps other machines out but not a web page. DNS rebinding
 * points a name the attacker controls at 127.0.0.1; the browser then counts the attacker's page
 * and this listener as one origin, so the page reads every answer whatever the CORS policy says.
 * The browser still sends the attacker's name as Host, so a listener that answers only the names
 * it is known by (loopback with its own port, its bind address, the public names a deployment
 * configures) gives a rebound page nothing.
 *
 * The body's type. A browser sends a cross-site POST without asking first (no CORS preflight)
 * when it declares text/plain, a form encoding or multipart, or no type at all. Every server here
 * read the body as JSON whatever it declared, so a page on any site could post to an open route
 * of a loopback node, or to the HR Tool. A method that carries a body now has to declare
 * application/json, or the type its route reads instead (the CP 575 upload's PDF). Declaring it is
 * what makes a browser ask first, and the CORS policy above answers that question.
 *
 * Framing. No other site may frame a page served here, where it could overlay the page to collect
 * clicks.
 */

/** The names every listener answers to on this machine. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** Bind addresses that name no single host. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * The Host names a deployment answers to beyond loopback: a reverse proxy's public name, or the
 * address its peers on other machines use. `ZKTRIDENT_PUBLIC_HOSTS`, comma-separated, each `name`
 * or `name:port`. None by default.
 */
export function resolvePublicHosts(env: NodeJS.ProcessEnv): string[] {
  return (env.ZKTRIDENT_PUBLIC_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** What a listener is known by, beside the loopback names. */
export interface HostPolicy {
  /** The address it is bound to. A specific address (not 0.0.0.0 or ::) is one of its names. */
  bindHost?: string;
  /** The names `resolvePublicHosts` read. */
  publicHosts?: readonly string[];
  /** Whether it speaks TLS: a Host with no port then means 443, otherwise 80. */
  tls?: boolean;
}

/** Whether a Host value ends in a port: `name:port`, or `[v6]:port`. */
function hasPort(authority: string): boolean {
  return authority.startsWith('[') ? /\]:\d+$/.test(authority) : /:\d+$/.test(authority);
}

/**
 * Whether a Host header names this listener on `port`, the port it accepted the connection on.
 *
 * A loopback name or the bind address matches with that port, or with no port when the port is
 * the scheme's default. A configured public name matches as written, and one written without a
 * port also matches with this port. A request with no Host matches nothing: every browser sends
 * one.
 */
export function hostAllowed(host: string | undefined, port: number, policy: HostPolicy = {}): boolean {
  if (!host) return false;
  const authority = host.trim().toLowerCase();
  const names: string[] = [...LOOPBACK_HOSTS];
  const bind = policy.bindHost?.trim().toLowerCase();
  if (bind && !WILDCARD_BINDS.has(bind)) names.push(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
  const defaultPort = policy.tls ? 443 : 80;
  if (names.some((name) => authority === `${name}:${port}` || (port === defaultPort && authority === name))) return true;
  return (policy.publicHosts ?? []).some((name) => authority === name || (!hasPort(name) && authority === `${name}:${port}`));
}

/** `hostAllowed` for a request, on the port it arrived on. */
export function requestHostAllowed(req: IncomingMessage, policy: HostPolicy = {}): boolean {
  return hostAllowed(req.headers.host, req.socket?.localPort ?? 0, policy);
}

/** The refusal of a request whose Host this listener does not answer to, sent as 421. */
export const MISDIRECTED_REQUEST = 'Misdirected request: this server does not answer for that Host';

/** The methods that carry a body. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What a route reads its body as unless it declares another type. */
export const JSON_BODY: readonly string[] = ['application/json'];

/** The media type a request declares, lower-cased and without parameters; '' when it declares none. */
export function requestMediaType(req: IncomingMessage): string {
  const header = req.headers['content-type'];
  return typeof header === 'string' ? header.split(';')[0].trim().toLowerCase() : '';
}

/**
 * Whether a request declares a body type its route reads. A method that carries no body passes.
 * A POST, PUT, PATCH or DELETE must declare one of `accepts` whether or not it sends a body: a
 * bodyless POST with no type is one a browser also sends cross-site without asking, and an open
 * route can act on it.
 */
export function bodyTypeAccepted(req: IncomingMessage, accepts: readonly string[] = JSON_BODY): boolean {
  if (!BODY_METHODS.has((req.method ?? 'GET').toUpperCase())) return true;
  return accepts.includes(requestMediaType(req));
}

/** The refusal of a body method that declares a type its route does not read, sent as 415. */
export const UNSUPPORTED_BODY_TYPE = 'Unsupported Media Type: send the request body as application/json';

/** The headers that keep a page served here out of another site's frames, as the sequencer sends them. */
export const NO_FRAMING_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
});

/*
 * ── Who a request comes from ─────────────────────────────────────────────────────────────
 *
 * From the review of the per-caller limits (A-89's): the insurer node counts what each caller files and asks (its
 * credentialing applications, its card recovery requests, its reads of an employer's plans to add) and the employer
 * node counts who asks its validate oracle, each by the caller's address. Behind a reverse proxy or a TLS terminator,
 * which ZKTRIDENT_PUBLIC_HOSTS exists to serve, every request arrives from the proxy, so every caller was one: a
 * source's ten open applications became the network's ten, and one client sending thirty bad card releases a minute
 * had every member's card recovery refused.
 *
 * A proxy names the client it forwards for in X-Forwarded-For, appending the address it took the request from to
 * whatever the request already carried. Any client can send the header too, so a listener reads it only when the
 * request's socket is a proxy ZKTRIDENT_TRUSTED_PROXIES lists, and reads it from the right, where the trusted proxies
 * wrote, never from the left, where the client may have.
 */

/**
 * The reverse proxies in front of a listener, whose X-Forwarded-For it reads to find the client:
 * `ZKTRIDENT_TRUSTED_PROXIES`, comma-separated, each an exact IPv4 or IPv6 address, returned as normalizeAddress writes
 * them. None by default, and then every request is its socket's.
 *
 * Throws, naming the variable and the entry, when an entry is not one IP address. A host name, a range or an address
 * with a port names no socket a listener can compare, and reading one as an address could trust what the operator
 * did not mean to, so the node refuses to start, as it does for a peer URL it cannot accept.
 */
export function resolveTrustedProxies(env: NodeJS.ProcessEnv): string[] {
  return trustedProxyList((env.ZKTRIDENT_TRUSTED_PROXIES ?? '').split(','), 'ZKTRIDENT_TRUSTED_PROXIES');
}

/**
 * `entries` as a trusted-proxy list: each trimmed, blanks dropped, written as normalizeAddress writes it, once. Throws,
 * naming `origin` and the entry, at one that is not an IP address.
 */
export function trustedProxyList(entries: readonly string[], origin: string): string[] {
  const list: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const address = normalizeAddress(entry);
    if (address === null) {
      throw new Error(
        `${origin}: "${entry}" is not an IP address. List each reverse proxy in front of this node by its exact ` +
          'address, IPv4 (192.0.2.10) or IPv6 (2001:db8::10), with no port, brackets, host name or range.',
      );
    }
    if (!list.includes(address)) list.push(address);
  }
  return list;
}

/**
 * The address of the client a request speaks for, from its socket's address and its X-Forwarded-For header.
 *
 * A request whose socket is not a trusted proxy is the socket's, whatever X-Forwarded-For it carries, so a client
 * cannot choose its own source. From a trusted proxy the header is walked from its right end, past each entry that is
 * itself a trusted proxy, and the first address that is not one is the client: the address the nearest trusted proxy
 * took the request from. A header whose every entry is a trusted proxy is the leftmost of them, a request one of the
 * proxies made itself.
 *
 * An entry that is not an IP address ("unknown", a name, an address with a port or in brackets, an empty entry) stops
 * the walk, and the request is the last trusted hop's: the proxy that wrote the entry, or handed it on. Reading past
 * the entry would read what the client wrote and let it choose its source; stopping costs only that the clients of a
 * proxy that writes no address are counted as that proxy, as they would be were it not trusted.
 *
 * Returns the socket's address as given when the socket is not a trusted proxy, and otherwise an address as
 * normalizeAddress writes it.
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: readonly string[],
): string | undefined {
  if (trustedProxies.length === 0) return socketAddress;
  const trusted = new Set<string>();
  for (const proxy of trustedProxies) {
    const address = normalizeAddress(proxy);
    if (address !== null) trusted.add(address);
  }
  let hop = normalizeAddress(socketAddress);
  if (hop === null || !trusted.has(hop)) return socketAddress;
  // Node joins a header sent more than once with ', '; a list is joined the same way.
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (!header) return hop;
  const entries = header.split(',');
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = normalizeAddress(entries[i].trim());
    if (entry === null) return hop;
    if (!trusted.has(entry)) return entry;
    hop = entry;
  }
  return hop;
}

/**
 * Whether a listener bound to `host` answers this machine only: localhost, 127.0.0.0/8 or ::1. A listener given no
 * host binds every interface.
 */
export function isLoopbackBind(host: string | undefined): boolean {
  if (typeof host !== 'string') return false;
  const name = host.trim().toLowerCase();
  if (name === 'localhost') return true;
  const address = normalizeAddress(name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name);
  return address === '::1' || (address !== null && address.startsWith('127.'));
}

/*
 * ── The `/rpc` proxies ───────────────────────────────────────────────────────────────────
 *
 * A node that serves a dashboard also forwards `POST /rpc` to the sequencer, because a page
 * served from `:4001` cannot reach `:3030` without one. Before this change each proxy
 * forwarded **any** method, so a browser could reach every sequencer method the sequencer
 * left open through a node that needed almost none of them.
 *
 * The lists below are what the dashboards in this repository actually call, read out of
 * their `rpc.js` helpers rather than guessed. Anything not on a role's list is refused by
 * the node, which is the point: the proxy stops being a universal passthrough.
 *
 * **What this does not fix.** The proxy cannot make an open sequencer method safe. A method
 * on one of these lists is still reachable directly on `:3030` by anyone who can reach the
 * sequencer, and several of them should require authentication and do not —
 * the claim queries take a wallet ID and return that wallet's records (A-13, phase D). The writes
 * that speak for a wallet — `l2_storeMessage`, `l2_registerPcpAssignment`, `l2_requestAttestation` —
 * now require that wallet's own signature at the sequencer (A10b), which is the only place they
 * could be fixed. Narrowing the proxy limits the blast radius of the node, not
 * of the sequencer.
 */

/** Status and chain reads every dashboard polls. */
const PROXY_BASE: readonly string[] = [
  'l2_getStatus',
  'l2_getHealth',
  'l2_getChainState',
];

/** Formulary and plan reads: the pharmacy, prescriber, insurer and member pages. */
const PROXY_CATALOG: readonly string[] = [
  'l2_getFormulary',
  'l2_getFormularyPage',
  'l2_getFormularyRoutes',
  'l2_getFormularyCategories',
  'l2_getFormularyDrugCount',
  'l2_getFormularyRoot',
  'l2_getDrugDetail',
  'l2_checkCoverage',
  'l2_getPlans',
  'l2_getPlan',
  'l2_getPlanLimits',
];

/**
 * The pre-script quote. With a walletId it is a member's own price and the drug's availability on its plan, and a
 * proxy would read it with the node's rights for whoever reached the port: the insurer node's key reads every member as
 * the plan. Owner decision 2026-10-19: the insurer, pharmacy and prescriber nodes do not forward it; their pages reach
 * a quote only through a route of the node itself, behind that node's admin credential (the prescriber node's
 * /estimate-cost). The member node forwards it for the member's own quote (its proxy answers only the device session
 * and signs as the wallet); the explorer relays only its page's own credential, so through it a member's quote answers
 * the operator alone.
 */
const PROXY_QUOTE: readonly string[] = ['l2_estimateCost'];

/**
 * What the member app needs on top of the catalog. The one write at the end is the member's own
 * proof submission. Sending a message and asking for a credential attestation go through the
 * member node's own routes, which sign them as the wallet (A10b); unsigned through the proxy they
 * could only be refused, so they are not forwarded.
 */
const PROXY_MEMBER: readonly string[] = [
  'l2_getClaimsByMember',
  'l2_getClaimsByNdc',
  'l2_getClaimsByPharmacy',
  'l2_getClaimsByPrescriber',
  'l2_getClaimAccumulatorRoot',
  'l2_getMessageStoreRoot',
  'l2_getMessagesByWallet',
  'l2_getMessagesBySender',
  'l2_getMessagesByRecipient',
  'l2_getMessagesByThread',
  'l2_getNetworkProviders',
  'l2_getReceipt',
  'l2_getReceiptsByWallet',
  'l2_getRegistrationWitnesses',
  'l2_reconstructAccumulator',
  'l2_getAttestation',
  'l2_getAttestationPublicKey',
  'l2_submitProof',
];

/**
 * What the explorer reads. All queries; `l2_forceBatch` is deliberately absent even though
 * the explorer's helper defines it, because it is a batch control and the proxy attaches no
 * credentials, so it could only ever have worked against a sequencer with admin auth off.
 */
const PROXY_EXPLORER: readonly string[] = [
  'l2_getAllBatches',
  'l2_getAllReceipts',
  'l2_getBatch',
  'l2_getBlock',
  'l2_getReceipt',
  'l2_getReceiptsByWallet',
  'l2_getAuditLog',
  'l2_getChainProof',
  'l2_getClaimAccumulatorRoot',
  'l2_getClaimWithProof',
  'l2_getClaimsByMember',
  'l2_getClaimsByNdc',
  'l2_getClaimsByPharmacy',
  'l2_getClaimsByPrescriber',
  'l2_getMessageStoreRoot',
  'l2_getMessagesByWallet',
  'l2_getMessagesBySender',
  'l2_getMessagesByRecipient',
  'l2_getMessagesByThread',
  'l2_getLeviathanStatus',
  'l2_getPartitionLeaders',
  'l2_getPeerInfo',
  'l2_getPeerList',
  'l2_getQuorumStatus',
  'l2_getStateCertificate',
  'l2_getStateDigest',
  'l2_reconstructAccumulator',
  'l2_detectDuplicateClaims',
  'l2_verifyChainIntegrity',
  'l2_verifyFinancialBalance',
];

/** The methods each role's own dashboard calls. Any other method is refused by the node. */
const PROXY_METHODS_BY_ROLE: Record<string, readonly string[]> = {
  member: [...PROXY_BASE, ...PROXY_CATALOG, ...PROXY_QUOTE, ...PROXY_MEMBER],
  explorer: [...PROXY_BASE, ...PROXY_CATALOG, ...PROXY_QUOTE, ...PROXY_EXPLORER],
  pharmacy: [...PROXY_BASE, ...PROXY_CATALOG],
  prescriber: [...PROXY_BASE, ...PROXY_CATALOG],
  insurer: [...PROXY_BASE, ...PROXY_CATALOG],
  employer: [...PROXY_BASE],
};

export interface RpcProxyPolicy {
  enabled: boolean;
  allowed: Set<string>;
}

/**
 * Whether this node forwards `POST /rpc` to the sequencer, and which methods.
 *
 * On by default, because real pages depend on it: the member dashboard's helper defaults its
 * base URL to `location.origin`, so with no sequencer URL configured every one of its
 * twenty-nine sequencer calls goes through the member node's proxy, and the explorer's page
 * reaches the sequencer only this way. Turning the proxies off would have broken both.
 *
 * `ZKTRIDENT_RPC_PROXY=0` turns a node's proxy off, for a deployment whose pages address the
 * sequencer directly.
 *
 * A role with no entry gets no proxy at all rather than a default list, so adding a role
 * cannot silently open one.
 */
export function resolveRpcProxyPolicy(env: NodeJS.ProcessEnv, role: string): RpcProxyPolicy {
  const key = role.split(' ')[0].toLowerCase();
  const methods = PROXY_METHODS_BY_ROLE[key];

  if (!methods) {
    console.warn(
      '  [net] %s: no /rpc proxy method list for this role, so the proxy is closed. Add the ' +
        'role to PROXY_METHODS_BY_ROLE in network-policy.ts if its dashboard needs one.',
      role,
    );
    return { enabled: false, allowed: new Set() };
  }

  if ((env.ZKTRIDENT_RPC_PROXY ?? '1') !== '1') {
    console.log('  [net] %s: the /rpc proxy to the sequencer is disabled by configuration.', role);
    return { enabled: false, allowed: new Set() };
  }

  return { enabled: true, allowed: new Set(methods) };
}

/*
 * ── Peer URLs ────────────────────────────────────────────────────────────────────────────
 *
 * A node that tells another node something — a provider telling the insurer it has enrolled —
 * posts to the URL its own configuration names. The pharmacy's enrollment took that URL from the
 * request body instead (A-81, found by the security posture check of 2026-10-24), so whatever
 * could reach the port chose where the node sent its wallet ID and enrollment code: an address on
 * this machine or its network that the caller could not reach itself, or a hostile server for the
 * node's HTTP client to parse.
 *
 * A configured URL is checked as well, because a typo or a pasted value is configuration too.
 */

/** Whether a URL's host is this machine's loopback: `localhost`, 127.0.0.0/8 or `[::1]`, as `URL` normalizes them. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Why a peer URL is not one this node may call, or null when it is.
 *
 * Absolute `http:` or `https:` with a host, and nothing beside the path: no user name or password,
 * which would travel with every request and be logged, and no query or fragment, since the caller
 * appends its own path. Plain `http:` reaches this machine's loopback only. A peer on another host
 * is reached over `https:`, so nothing on the network between can read or rewrite what is sent;
 * the cluster's own links become mutual TLS in phase E.
 */
export function peerUrlError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `uses ${url.protocol} rather than http: or https:`;
  if (!url.hostname) return 'names no host';
  if (url.username || url.password) return 'carries a user name or password';
  if (url.search || url.hash) return 'carries a query or a fragment';
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return `reaches ${url.hostname} over plain http; a peer on another host is reached over https`;
  }
  return null;
}

/**
 * A peer URL from the environment: undefined when the variable is unset or blank, the URL without
 * its trailing slashes when `peerUrlError` accepts it. Throws, naming the variable, when it does
 * not, so the node refuses to start rather than run without the peer it was configured to reach.
 */
export function resolvePeerUrl(env: NodeJS.ProcessEnv, name: string, role: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const reason = peerUrlError(raw);
  if (reason) throw new Error(`${role}: ${name} ${reason}`);
  return raw.replace(/\/+$/, '');
}
