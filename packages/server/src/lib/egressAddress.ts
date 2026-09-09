/**
 * Address classification: which literal addresses the deployment may reach.
 *
 * Split from `toolEgress.ts` so the rules about addresses can be read — and
 * tested — apart from the code that makes requests with them. The parsers here,
 * not `node:net`'s `isIP`, are the validator: this feeds a security decision, so
 * the code that decides must be the code that rejects, and every malformed
 * shape stays reachable from a test.
 */

export type EgressCidr = {
  bytes: Uint8Array;
  bits: number;
};

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
export const toBytes = (address: string): Uint8Array | null => {
  return address.includes(':') ? ipv6ToBytes(address) : ipv4ToBytes(address);
};

export const inCidr = (address: Uint8Array, cidr: EgressCidr): boolean => {
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
