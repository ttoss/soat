import { lookup } from 'node:dns/promises';

import { DomainError } from '../errors';
import {
  type EgressCidr,
  inCidr,
  isPublicAddress,
  toBytes,
} from './egressAddress';

export type { EgressCidr } from './egressAddress';
export { isPublicAddress } from './egressAddress';

/**
 * Egress control for every destination a tenant can make the server request.
 *
 * SOAT never executes agent-authored code, but an `http`/`mcp` tool is a
 * `fetch` the server performs on the agent's behalf, and by default that could
 * name the deployment's own network: a sibling service, the API's loopback, or
 * the cloud metadata endpoint that hands out the instance's IAM credentials.
 * A tool is not the only such destination — a webhook URL, an AI provider's
 * `base_url` and a service-account key file's `token_uri` are all stored by a
 * tenant and requested by the server, so each one reaches the network through
 * this module too (`egressFetch.ts` is the `fetch`-shaped door).
 *
 * So: **such a request reaches the public internet, and nothing else.** Anything
 * not publicly routable — loopback, RFC1918, link-local, CGNAT, IPv6 ULA — is
 * refused unless declared in `TOOL_EGRESS_ALLOWED_HOSTS`, which keeps the
 * legitimate internal-service case available as an explicit operator decision.
 *
 * Two things make this a real control rather than a string check: it validates
 * the **resolved address** (`evil.com` can A-record to `169.254.169.254`), and
 * it validates **every redirect hop** (`fetch` follows redirects unchecked).
 *
 * Deliberate limitation: a TOCTOU window between the DNS check and the socket
 * connect, since pinning the connection requires replacing the fetch
 * dispatcher. The allowlist is deployment-level, not per-project.
 */

export type EgressHostEntry = {
  host: string;
  port?: number;
  wildcard: boolean;
};

export type EgressAllowlist = {
  hosts: EgressHostEntry[];
  cidrs: EgressCidr[];
};

const ENV_VAR = 'TOOL_EGRESS_ALLOWED_HOSTS';

const MAX_REDIRECTS = 5;

/**
 * Headers that carry a credential and must not survive a redirect to another
 * origin — the classic way an SSRF guard leaks the very secret it protects.
 * Custom credential headers on a tool cannot be recognized here; a redirect to
 * another origin is why `execute.auth` exists rather than a hand-set header.
 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

const blocked = (
  message: string,
  meta?: Record<string, unknown>
): DomainError => {
  return new DomainError('TOOL_EGRESS_BLOCKED', message, meta);
};

// ── Allowlist ────────────────────────────────────────────────────────────

const invalidEntry = (entry: string): DomainError => {
  return new DomainError(
    'VALIDATION_FAILED',
    `${ENV_VAR} entry "${entry}" is not a hostname, host:port, *.suffix or CIDR.`
  );
};

const parsePort = (raw: string, entry: string): number => {
  if (!/^\d{1,5}$/.test(raw)) throw invalidEntry(entry);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw invalidEntry(entry);
  return port;
};

const parseCidrEntry = (entry: string): EgressCidr => {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address || !prefix) throw invalidEntry(entry);
  const bytes = toBytes(address);
  if (!bytes || !/^\d{1,3}$/.test(prefix)) throw invalidEntry(entry);
  const bits = Number(prefix);
  if (bits > bytes.length * 8) throw invalidEntry(entry);
  return { bytes, bits };
};

/** Splits an entry into its host and optional port, before validation. */
const splitHostPort = (args: {
  value: string;
  entry: string;
}): { host: string; port?: number } => {
  // `[::1]:8080` — the only unambiguous way to write an IPv6 host with a port.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(args.value);
  if (bracketed) {
    const host = bracketed[1] as string;
    if (toBytes(host) === null) throw invalidEntry(args.entry);
    return bracketed[2] === undefined
      ? { host }
      : { host, port: parsePort(bracketed[2], args.entry) };
  }

  // A bare IPv6 literal is full of colons, so only split a port off when the
  // remainder is not itself an address.
  const lastColon =
    toBytes(args.value) === null ? args.value.lastIndexOf(':') : -1;
  if (lastColon === -1) return { host: args.value };
  return {
    host: args.value.slice(0, lastColon),
    port: parsePort(args.value.slice(lastColon + 1), args.entry),
  };
};

const parseHostEntry = (entry: string): EgressHostEntry => {
  const wildcard = entry.startsWith('*');
  const { host: rawHost, port } = splitHostPort({
    value: wildcard ? entry.slice(1) : entry,
    entry,
  });
  const host = rawHost.toLowerCase();

  const valid = wildcard
    ? /^\.[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)
    : toBytes(host) !== null || /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host);
  if (!valid) throw invalidEntry(entry);

  return port === undefined ? { host, wildcard } : { host, port, wildcard };
};

export const parseEgressAllowlist = (
  raw: string | null | undefined
): EgressAllowlist => {
  const allowlist: EgressAllowlist = { hosts: [], cidrs: [] };
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    if (entry.includes('/')) {
      allowlist.cidrs.push(parseCidrEntry(entry));
      continue;
    }
    allowlist.hosts.push(parseHostEntry(entry));
  }
  return allowlist;
};

let cached: { raw: string | undefined; allowlist: EgressAllowlist } | undefined;

/**
 * The deployment's allowlist, parsed once per distinct env value. A malformed
 * entry throws on every call rather than being dropped: an operator who
 * believes they allowed an internal host and silently did not is the failure
 * this whole module exists to prevent.
 */
export const getEgressAllowlist = (): EgressAllowlist => {
  const raw = process.env[ENV_VAR];
  if (!cached || cached.raw !== raw) {
    cached = { raw, allowlist: parseEgressAllowlist(raw) };
  }
  return cached.allowlist;
};

export const isAddressAllowed = (args: {
  address: string;
  allowlist: EgressAllowlist;
}): boolean => {
  const bytes = toBytes(args.address);
  if (!bytes) return false;
  if (isPublicAddress(args.address)) return true;
  return args.allowlist.cidrs.some((entry) => {
    return inCidr(bytes, entry);
  });
};

const matchesHostEntry = (args: {
  hostname: string;
  port: number;
  allowlist: EgressAllowlist;
}): boolean => {
  return args.allowlist.hosts.some((entry) => {
    if (entry.port !== undefined && entry.port !== args.port) return false;
    return entry.wildcard
      ? args.hostname.endsWith(entry.host)
      : args.hostname === entry.host;
  });
};

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/**
 * What the messages call the destination. A tool target is the default because
 * tools were the first caller, but the guard now fronts every outbound request
 * whose destination a tenant chose — a webhook URL, a provider's `base_url`, a
 * service-account key file's `token_uri` — and telling an operator their
 * webhook was refused as a "tool target" sends them to the wrong record.
 */
const DEFAULT_NOUN = 'Tool target';

type ShapeVerdict = { settled: true } | { settled: false; hostname: string };

/**
 * The half of the decision that needs no DNS: the URL parses, the scheme is one
 * we make requests on, and a literal address is either public or allowed.
 * `settled` means the destination is allowed on the strength of that alone;
 * otherwise the hostname still has to be resolved.
 */
const assertShape = (args: {
  url: string;
  allowlist: EgressAllowlist;
  noun: string;
}): ShapeVerdict => {
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw blocked(`${args.noun} "${args.url}" is not a valid URL.`);
  }

  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  if (defaultPort === undefined) {
    throw blocked(
      `${args.noun} scheme "${parsed.protocol}" is not allowed; use http or https.`
    );
  }

  const port = parsed.port === '' ? defaultPort : Number(parsed.port);
  // WHATWG keeps an IPv6 host bracketed; addresses are compared unbracketed.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (matchesHostEntry({ hostname, port, allowlist: args.allowlist })) {
    return { settled: true };
  }

  if (toBytes(hostname) !== null) {
    if (isAddressAllowed({ address: hostname, allowlist: args.allowlist })) {
      return { settled: true };
    }
    throw blocked(
      `${args.noun} ${hostname} is not publicly routable. Add it to ${ENV_VAR} to allow it.`,
      { tool_url: args.url, tool_address: hostname }
    );
  }

  return { settled: false, hostname };
};

/**
 * Throws `TOOL_EGRESS_BLOCKED` unless every address `url` resolves to is either
 * publicly routable or covered by the allowlist. Resolves silently otherwise.
 */
export const assertEgressAllowed = async (args: {
  url: string;
  allowlist: EgressAllowlist;
  noun?: string;
}): Promise<void> => {
  const noun = args.noun ?? DEFAULT_NOUN;
  const verdict = assertShape({
    url: args.url,
    allowlist: args.allowlist,
    noun,
  });
  if (verdict.settled) return;

  const { hostname } = verdict;

  let addresses: string[];
  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    addresses = resolved.map((entry) => {
      return entry.address;
    });
  } catch {
    throw blocked(`${noun} host "${hostname}" could not be resolved.`, {
      tool_url: args.url,
    });
  }

  const denied = addresses.find((address) => {
    return !isAddressAllowed({ address, allowlist: args.allowlist });
  });
  if (denied !== undefined) {
    throw blocked(
      `${noun} "${hostname}" resolves to ${denied}, which is not publicly routable. Add it to ${ENV_VAR} to allow it.`,
      { tool_url: args.url, tool_address: denied }
    );
  }
};

const nextRequest = (args: {
  status: number;
  from: URL;
  to: URL;
  method: string;
  body: RequestInit['body'];
  headers: Headers;
}): { method: string; body: RequestInit['body']; headers: Headers } => {
  const headers = new Headers(args.headers);
  if (args.from.origin !== args.to.origin) {
    for (const header of CREDENTIAL_HEADERS) headers.delete(header);
  }
  // 307/308 preserve the method and body; 301/302/303 degrade to GET, which is
  // what every HTTP client does and what a tool's target will expect.
  if (args.status === 307 || args.status === 308) {
    return { method: args.method, body: args.body, headers };
  }
  headers.delete('content-type');
  headers.delete('content-length');
  return { method: 'GET', body: undefined, headers };
};

/**
 * `fetch` with the egress guard applied to the initial URL and to every
 * redirect hop. Redirects are followed manually — `redirect: 'follow'` would
 * reach the `Location` target without any check.
 */
export const fetchWithEgressGuard = async (
  url: string,
  init: RequestInit = {},
  options: { allowlist?: EgressAllowlist; noun?: string } = {}
): Promise<Response> => {
  const allowlist = options.allowlist ?? getEgressAllowlist();
  const noun = options.noun ?? DEFAULT_NOUN;

  let currentUrl = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertEgressAllowed({ url: currentUrl, allowlist, noun });

    const response = await fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual',
    });

    const location = response.headers.get('location');
    if (
      location === null ||
      ![301, 302, 303, 307, 308].includes(response.status)
    ) {
      return response;
    }

    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw blocked(
        `${noun} redirected to an invalid Location "${location}".`,
        { tool_url: currentUrl }
      );
    }

    const next = nextRequest({
      status: response.status,
      from: new URL(currentUrl),
      to: target,
      method,
      body,
      headers,
    });
    method = next.method;
    body = next.body;
    headers = next.headers;
    currentUrl = target.toString();
  }

  throw blocked(
    `${noun} exceeded ${MAX_REDIRECTS} redirects; giving up rather than following further.`,
    { tool_url: url }
  );
};
