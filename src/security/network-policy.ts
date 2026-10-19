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
        '127.0.0.1 unless this host is meant to serve other machines.',
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
