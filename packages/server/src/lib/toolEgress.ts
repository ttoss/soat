import { lookup } from 'node:dns/promises';

import { DomainError } from '../errors';

/**
 * Egress control for destinations an agent's tool call can reach.
 *
 * SOAT never executes agent-authored code, so the host is not reachable
 * through a shell — but an `http`/`mcp` tool is a `fetch` the server performs
 * on the agent's behalf, and by default that could name the deployment's own
 * network: a sibling service, the API's own loopback, or the cloud metadata
 * endpoint that hands out the instance's IAM credentials.
 *
 * The rule is therefore: **a tool reaches the public internet, and nothing
 * else.** Anything not publicly routable — loopback, RFC1918, link-local,
 * CGNAT, IPv6 ULA — is refused unless the deployment declares it in
 * `TOOL_EGRESS_ALLOWED_HOSTS`. That inverts the default to safe while keeping
 * the legitimate case (a tool calling an internal service) available as an
 * explicit, operator-authored decision.
 *
 * Two things make this a real control rather than a string check on the URL:
 *
 * - **It validates the resolved address, not the hostname.** `evil.com` with an
 *   A record pointing at `169.254.169.254` reads as an ordinary public URL.
 * - **It validates every redirect hop.** A legitimate first request answering
 *   `302 Location: http://169.254.169.254/…` would otherwise walk straight in,
 *   since `fetch` follows redirects with no further checks.
 *
 * Known limitation, deliberate: between the DNS check and the socket connect
 * there is a TOCTOU window a rebinding attacker could use, because pinning the
 * connection to the checked address requires replacing the fetch dispatcher.
 * The allowlist is a deployment-level control, not a per-project one.
 */

export type EgressHostEntry = {
  host: string;
  port?: number;
  wildcard: boolean;
};

export type EgressCidr = {
  bytes: Uint8Array;
  bits: number;
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

// ── Address parsing ──────────────────────────────────────────────────────

const ipv4ToBytes = (address: string): Uint8Array | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] as string;
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
};

const ipv6ToBytes = (address: string): Uint8Array | null => {
  let head = address;
  let tail = '';
  const doubleColon = address.indexOf('::');
  if (doubleColon !== -1) {
    head = address.slice(0, doubleColon);
    tail = address.slice(doubleColon + 2);
    if (tail.includes('::')) return null;
  }

  const expand = (section: string): number[] | null => {
    if (section === '') return [];
    const groups: number[] = [];
    const pieces = section.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] as string;
      // A trailing dotted-quad ("::ffff:1.2.3.4") occupies the last two groups.
      if (piece.includes('.')) {
        if (i !== pieces.length - 1) return null;
        const v4 = ipv4ToBytes(piece);
        if (!v4) return null;
        groups.push(((v4[0] as number) << 8) | (v4[1] as number));
        groups.push(((v4[2] as number) << 8) | (v4[3] as number));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const headGroups = expand(head);
  const tailGroups = expand(tail);
  if (!headGroups || !tailGroups) return null;

  const total = headGroups.length + tailGroups.length;
  if (doubleColon === -1) {
    if (total !== 8) return null;
  } else if (total > 7) {
    return null;
  }

  const groups = [
    ...headGroups,
    ...new Array<number>(8 - total).fill(0),
    ...tailGroups,
  ];
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
};

/**
 * Parses a literal address to bytes, or `null` when it is not one. The parsers
 * above — not `node:net`'s `isIP` — are the validator: this feeds a security
 * decision, so the code that decides must be the code that rejects, and every
 * malformed shape stays reachable from a test.
 */
const toBytes = (address: string): Uint8Array | null => {
  return address.includes(':') ? ipv6ToBytes(address) : ipv4ToBytes(address);
};

const inCidr = (address: Uint8Array, cidr: EgressCidr): boolean => {
  if (address.length !== cidr.bytes.length) return false;
  const fullBytes = Math.floor(cidr.bits / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (address[i] !== cidr.bytes[i]) return false;
  }
  const remainingBits = cidr.bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    ((address[fullBytes] as number) & mask) ===
    ((cidr.bytes[fullBytes] as number) & mask)
  );
};

const cidr = (notation: string): EgressCidr => {
  const [address, prefix] = notation.split('/');
  const bytes = toBytes(address as string);
  if (!bytes) throw new Error(`unparseable CIDR address: ${notation}`);
  return { bytes, bits: Number(prefix) };
};

/**
 * Everything that is not publicly routable. RFC1918 and loopback are here for
 * the obvious reason; link-local is here because that is where every cloud
 * provider's metadata service lives (`169.254.169.254`, plus ECS's
 * `169.254.170.2` and EKS Pod Identity's `169.254.170.23`) — enumerating those
 * addresses individually is a list that silently ages, the range is not.
 */
const NON_PUBLIC_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map(cidr);

const NON_PUBLIC_V6 = [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map(cidr);

const V4_MAPPED = cidr('::ffff:0:0/96');
const NAT64 = cidr('64:ff9b::/96');

export const isPublicAddress = (address: string): boolean => {
  const bytes = toBytes(address);
  if (!bytes) return false;

  if (bytes.length === 16) {
    // An IPv4 address wearing an IPv6 hat — `::ffff:169.254.169.254` and the
    // NAT64 prefix are both ways to spell a v4 destination, so classify the
    // embedded address rather than the wrapper.
    if (inCidr(bytes, V4_MAPPED) || inCidr(bytes, NAT64)) {
      return NON_PUBLIC_V4.every((range) => {
        return !inCidr(bytes.slice(12), range);
      });
    }
    return NON_PUBLIC_V6.every((range) => {
      return !inCidr(bytes, range);
    });
  }

  return NON_PUBLIC_V4.every((range) => {
    return !inCidr(bytes, range);
  });
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
 * Throws `TOOL_EGRESS_BLOCKED` unless every address `url` resolves to is either
 * publicly routable or covered by the allowlist. Resolves silently otherwise.
 */
export const assertEgressAllowed = async (args: {
  url: string;
  allowlist: EgressAllowlist;
}): Promise<void> => {
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw blocked(`Tool target "${args.url}" is not a valid URL.`);
  }

  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  if (defaultPort === undefined) {
    throw blocked(
      `Tool target scheme "${parsed.protocol}" is not allowed; use http or https.`
    );
  }

  const port = parsed.port === '' ? defaultPort : Number(parsed.port);
  // WHATWG keeps an IPv6 host bracketed; addresses are compared unbracketed.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (matchesHostEntry({ hostname, port, allowlist: args.allowlist })) return;

  if (toBytes(hostname) !== null) {
    if (isAddressAllowed({ address: hostname, allowlist: args.allowlist })) {
      return;
    }
    throw blocked(
      `Tool target ${hostname} is not publicly routable. Add it to ${ENV_VAR} to allow it.`,
      { tool_url: args.url, tool_address: hostname }
    );
  }

  let addresses: string[];
  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    addresses = resolved.map((entry) => {
      return entry.address;
    });
  } catch {
    throw blocked(`Tool target host "${hostname}" could not be resolved.`, {
      tool_url: args.url,
    });
  }

  const denied = addresses.find((address) => {
    return !isAddressAllowed({ address, allowlist: args.allowlist });
  });
  if (denied !== undefined) {
    throw blocked(
      `Tool target "${hostname}" resolves to ${denied}, which is not publicly routable. Add it to ${ENV_VAR} to allow it.`,
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
  allowlist: EgressAllowlist = getEgressAllowlist()
): Promise<Response> => {
  let currentUrl = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertEgressAllowed({ url: currentUrl, allowlist });

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
        `Tool target redirected to an invalid Location "${location}".`,
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
    `Tool target exceeded ${MAX_REDIRECTS} redirects; giving up rather than following further.`,
    { tool_url: url }
  );
};
