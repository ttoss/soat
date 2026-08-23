import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  assertEgressAllowed,
  fetchWithEgressGuard,
  getEgressAllowlist,
  isAddressAllowed,
  isPublicAddress,
  parseEgressAllowlist,
} from 'src/lib/toolEgress';

/**
 * Starts an HTTP server bound to loopback and resolves its port. Loopback is
 * the point: every destination in this file is one the guard blocks by
 * default, so the allowlist is what the assertions actually exercise.
 */
const startServer = async (
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; port: number; origin: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    return server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, port, origin: `http://127.0.0.1:${port}` };
};

const closeServer = (server: Server): Promise<void> => {
  return new Promise<void>((resolve) => {
    server.close(() => {
      return resolve();
    });
  });
};

describe('toolEgress', () => {
  describe('isPublicAddress', () => {
    test.each([
      ['8.8.8.8', true],
      ['203.0.113.9', true],
      ['172.32.0.1', true],
      ['100.128.0.1', true],
      ['10.0.0.1', false],
      ['10.255.255.255', false],
      ['172.16.0.1', false],
      ['172.31.255.255', false],
      ['192.168.1.1', false],
      ['127.0.0.1', false],
      ['0.0.0.0', false],
      ['169.254.169.254', false],
      ['169.254.170.2', false],
      ['100.100.100.200', false],
      ['224.0.0.1', false],
      ['255.255.255.255', false],
    ])('classifies IPv4 %s as public=%s', (address, expected) => {
      expect(isPublicAddress(address)).toBe(expected);
    });

    test.each([
      ['2606:4700:4700::1111', true],
      ['2001:4860:4860::8888', true],
      ['::1', false],
      ['::', false],
      ['fe80::1', false],
      ['fd00:ec2::254', false],
      ['fc00::1', false],
      ['ff02::1', false],
    ])('classifies IPv6 %s as public=%s', (address, expected) => {
      expect(isPublicAddress(address)).toBe(expected);
    });

    test('unwraps an IPv4-mapped IPv6 address and classifies the IPv4', () => {
      expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
      expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
      expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
    });

    test('unwraps a NAT64-embedded IPv4 address', () => {
      // 64:ff9b::/96 embeds an IPv4 address in its low 32 bits, so a NAT64
      // prefix is a way to spell 169.254.169.254 that looks nothing like it.
      expect(isPublicAddress('64:ff9b::a9fe:a9fe')).toBe(false);
      expect(isPublicAddress('64:ff9b::808:808')).toBe(true);
    });

    test.each([
      'not-an-ip',
      '',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3.-1',
      '1:2:3',
      '1:2:3:4:5:6:7:8:9',
      '::1::2',
      'gggg::1',
      '::ffff:1.2.3.4.5',
      '::ffff:1.2.3.4:9',
      '::12345',
      '1:2:3:4:5:6:7::8',
    ])('treats the malformed address %s as non-public', (address) => {
      // The parsers, not node:net's isIP, decide — so every malformed shape
      // has to be rejected here rather than assumed away.
      expect(isPublicAddress(address)).toBe(false);
    });

    test('treats an unparseable address as non-public', () => {
      expect(isPublicAddress('not-an-ip')).toBe(false);
      expect(isPublicAddress('')).toBe(false);
    });
  });

  describe('parseEgressAllowlist', () => {
    test('an unset or empty value allows nothing beyond public addresses', () => {
      expect(parseEgressAllowlist(undefined)).toEqual({
        hosts: [],
        cidrs: [],
      });
      expect(parseEgressAllowlist('   ')).toEqual({ hosts: [], cidrs: [] });
    });

    test('parses hosts, host:port pairs and wildcards, trimming whitespace', () => {
      const allowlist = parseEgressAllowlist(
        ' server:5047 , ollama , *.internal.acme.com '
      );
      expect(allowlist.hosts).toEqual([
        { host: 'server', port: 5047, wildcard: false },
        { host: 'ollama', wildcard: false },
        { host: '.internal.acme.com', wildcard: true },
      ]);
    });

    test('lowercases hostnames so matching is case-insensitive', () => {
      expect(parseEgressAllowlist('Billing.SVC.Cluster.Local').hosts).toEqual([
        { host: 'billing.svc.cluster.local', wildcard: false },
      ]);
    });

    test('parses a bracketed IPv6 host with and without a port', () => {
      expect(parseEgressAllowlist('[::1]:8080,[fd00::1]').hosts).toEqual([
        { host: '::1', port: 8080, wildcard: false },
        { host: 'fd00::1', wildcard: false },
      ]);
    });

    test('parses a bare IPv6 literal without splitting a port off it', () => {
      expect(parseEgressAllowlist('fd00::1').hosts).toEqual([
        { host: 'fd00::1', wildcard: false },
      ]);
    });

    test('parses IPv4 and IPv6 CIDRs', () => {
      const allowlist = parseEgressAllowlist('10.42.0.0/16,fd12:3456::/32');
      expect(allowlist.cidrs).toHaveLength(2);
      expect(allowlist.cidrs[0]?.bits).toBe(16);
      expect(allowlist.cidrs[1]?.bits).toBe(32);
    });

    test.each([
      '10.42.0.0/33',
      '10.42.0.0/-1',
      '10.42.0.0/abc',
      'fd00::/129',
      'not an entry',
      ':5047',
      'server:notaport',
      'server:0',
      'server:70000',
      '[not-an-address]:8080',
      '[::1',
    ])('rejects the malformed entry %s instead of ignoring it', (entry) => {
      // A silently dropped entry is a deployment that believes it allowed an
      // internal host and did not — fail loudly at parse instead.
      expect(() => {
        return parseEgressAllowlist(entry);
      }).toThrow(/TOOL_EGRESS_ALLOWED_HOSTS/);
    });
  });

  describe('getEgressAllowlist', () => {
    const original = process.env.TOOL_EGRESS_ALLOWED_HOSTS;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
        return;
      }
      process.env.TOOL_EGRESS_ALLOWED_HOSTS = original;
    });

    test('reads the deployment env var and re-parses when it changes', () => {
      delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
      expect(getEgressAllowlist()).toEqual({ hosts: [], cidrs: [] });

      process.env.TOOL_EGRESS_ALLOWED_HOSTS = 'server:5047';
      expect(getEgressAllowlist().hosts).toEqual([
        { host: 'server', port: 5047, wildcard: false },
      ]);

      // Same value again must come back identical (the cached parse).
      expect(getEgressAllowlist().hosts).toEqual([
        { host: 'server', port: 5047, wildcard: false },
      ]);
    });

    test('throws on a malformed env value instead of allowing nothing silently', () => {
      process.env.TOOL_EGRESS_ALLOWED_HOSTS = '10.0.0.0/99';
      expect(() => {
        return getEgressAllowlist();
      }).toThrow(/TOOL_EGRESS_ALLOWED_HOSTS/);
    });
  });

  describe('isAddressAllowed', () => {
    const allowlist = parseEgressAllowlist('10.42.0.0/16,fd12:3456::/32');

    test('a public address is allowed with an empty allowlist', () => {
      expect(
        isAddressAllowed({
          address: '8.8.8.8',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).toBe(true);
    });

    test('an internal address is allowed only inside a listed CIDR', () => {
      expect(isAddressAllowed({ address: '10.42.1.5', allowlist })).toBe(true);
      expect(isAddressAllowed({ address: '10.43.1.5', allowlist })).toBe(false);
      expect(isAddressAllowed({ address: 'fd12:3456::9', allowlist })).toBe(
        true
      );
      expect(isAddressAllowed({ address: 'fd12:9999::9', allowlist })).toBe(
        false
      );
    });

    test('a /0 CIDR allows the whole family', () => {
      const wide = parseEgressAllowlist('0.0.0.0/0');
      expect(isAddressAllowed({ address: '10.0.0.1', allowlist: wide })).toBe(
        true
      );
      expect(isAddressAllowed({ address: 'fd00::1', allowlist: wide })).toBe(
        false
      );
    });

    test('an unparseable address is never allowed', () => {
      expect(isAddressAllowed({ address: 'nonsense', allowlist })).toBe(false);
    });
  });

  describe('assertEgressAllowed', () => {
    test('allows a public IP literal without a DNS lookup', async () => {
      await expect(
        assertEgressAllowed({
          url: 'http://8.8.8.8/health',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).resolves.toBeUndefined();
    });

    test('blocks a loopback IP literal by default', async () => {
      await expect(
        assertEgressAllowed({
          url: 'http://127.0.0.1:8080/x',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('blocks a hostname that resolves to a loopback address', async () => {
      await expect(
        assertEgressAllowed({
          url: 'http://localhost:8080/x',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('allows a loopback hostname listed by name', async () => {
      await expect(
        assertEgressAllowed({
          url: 'http://localhost:8080/x',
          allowlist: parseEgressAllowlist('localhost'),
        })
      ).resolves.toBeUndefined();
    });

    test('honours the port when the allowlist entry carries one', async () => {
      const allowlist = parseEgressAllowlist('127.0.0.1:8080');
      await expect(
        assertEgressAllowed({ url: 'http://127.0.0.1:8080/x', allowlist })
      ).resolves.toBeUndefined();
      await expect(
        assertEgressAllowed({ url: 'http://127.0.0.1:9090/x', allowlist })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('applies the implicit scheme port against a listed port', async () => {
      const allowlist = parseEgressAllowlist('127.0.0.1:80');
      await expect(
        assertEgressAllowed({ url: 'http://127.0.0.1/x', allowlist })
      ).resolves.toBeUndefined();
      await expect(
        assertEgressAllowed({
          url: 'https://127.0.0.1/x',
          allowlist,
        })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('matches a wildcard entry on the suffix, not as a substring', async () => {
      const allowlist = parseEgressAllowlist('*.localhost.test,*.localhost');
      await expect(
        assertEgressAllowed({ url: 'http://api.localhost/x', allowlist })
      ).resolves.toBeUndefined();
      await expect(
        assertEgressAllowed({ url: 'http://evil-localhost/x', allowlist })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('blocks a non-http scheme outright', async () => {
      await expect(
        assertEgressAllowed({
          url: 'file:///etc/passwd',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('blocks a malformed URL', async () => {
      await expect(
        assertEgressAllowed({
          url: 'not a url',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });

    test('blocks a hostname that does not resolve', async () => {
      await expect(
        assertEgressAllowed({
          url: 'http://this-host-does-not-exist.invalid/x',
          allowlist: parseEgressAllowlist(undefined),
        })
      ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
    });
  });

  describe('fetchWithEgressGuard', () => {
    test('blocks a loopback target that is not allowlisted', async () => {
      const { server, origin } = await startServer((_req, res) => {
        res.end('reached');
      });
      try {
        await expect(
          fetchWithEgressGuard(origin, {}, parseEgressAllowlist(undefined))
        ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
      } finally {
        await closeServer(server);
      }
    });

    test('reaches an allowlisted loopback target', async () => {
      const { server, origin, port } = await startServer((_req, res) => {
        res.end('reached');
      });
      try {
        const response = await fetchWithEgressGuard(
          origin,
          {},
          parseEgressAllowlist(`127.0.0.1:${port}`)
        );
        await expect(response.text()).resolves.toBe('reached');
      } finally {
        await closeServer(server);
      }
    });

    test('blocks a redirect that leaves the allowlist', async () => {
      // The test that proves the guard is not cosmetic: the first hop is
      // allowed, and the destination is only reachable via the Location header.
      const target = await startServer((_req, res) => {
        res.end('SECRET');
      });
      const redirector = await startServer((_req, res) => {
        res.writeHead(302, { Location: target.origin });
        res.end();
      });
      try {
        await expect(
          fetchWithEgressGuard(
            redirector.origin,
            {},
            parseEgressAllowlist(`127.0.0.1:${redirector.port}`)
          )
        ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
      } finally {
        await closeServer(redirector.server);
        await closeServer(target.server);
      }
    });

    test('follows a redirect that stays inside the allowlist', async () => {
      const target = await startServer((_req, res) => {
        res.end('final');
      });
      const redirector = await startServer((_req, res) => {
        res.writeHead(302, { Location: `${target.origin}/next` });
        res.end();
      });
      try {
        const response = await fetchWithEgressGuard(
          redirector.origin,
          { method: 'POST', body: 'payload' },
          parseEgressAllowlist('127.0.0.1')
        );
        await expect(response.text()).resolves.toBe('final');
      } finally {
        await closeServer(redirector.server);
        await closeServer(target.server);
      }
    });

    test('follows a relative Location header', async () => {
      const { server, origin } = await startServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { Location: '/done' });
          res.end();
          return;
        }
        res.end('relative-ok');
      });
      try {
        const response = await fetchWithEgressGuard(
          `${origin}/start`,
          {},
          parseEgressAllowlist('127.0.0.1')
        );
        await expect(response.text()).resolves.toBe('relative-ok');
      } finally {
        await closeServer(server);
      }
    });

    test('drops the Authorization header when a redirect changes origin', async () => {
      let receivedAuth: string | undefined;
      const target = await startServer((req, res) => {
        receivedAuth = req.headers.authorization;
        res.end('done');
      });
      const redirector = await startServer((_req, res) => {
        res.writeHead(302, { Location: target.origin });
        res.end();
      });
      try {
        await fetchWithEgressGuard(
          redirector.origin,
          { headers: { Authorization: 'Bearer super-secret' } },
          parseEgressAllowlist('127.0.0.1')
        );
        expect(receivedAuth).toBeUndefined();
      } finally {
        await closeServer(redirector.server);
        await closeServer(target.server);
      }
    });

    test('keeps the Authorization header on a same-origin redirect', async () => {
      let receivedAuth: string | undefined;
      const { server, origin } = await startServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { Location: '/done' });
          res.end();
          return;
        }
        receivedAuth = req.headers.authorization;
        res.end('done');
      });
      try {
        await fetchWithEgressGuard(
          `${origin}/start`,
          { headers: { Authorization: 'Bearer keep-me' } },
          parseEgressAllowlist('127.0.0.1')
        );
        expect(receivedAuth).toBe('Bearer keep-me');
      } finally {
        await closeServer(server);
      }
    });

    test('turns a 303 into a GET and drops the body', async () => {
      let method: string | undefined;
      const { server, origin } = await startServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(303, { Location: '/done' });
          res.end();
          return;
        }
        method = req.method;
        res.end('done');
      });
      try {
        await fetchWithEgressGuard(
          `${origin}/start`,
          { method: 'POST', body: 'payload' },
          parseEgressAllowlist('127.0.0.1')
        );
        expect(method).toBe('GET');
      } finally {
        await closeServer(server);
      }
    });

    test('preserves the method and body across a 307', async () => {
      let seen: { method?: string; body?: string } = {};
      const { server, origin } = await startServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(307, { Location: '/done' });
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += String(chunk);
        });
        req.on('end', () => {
          seen = { method: req.method, body };
          res.end('done');
        });
      });
      try {
        await fetchWithEgressGuard(
          `${origin}/start`,
          { method: 'POST', body: 'payload' },
          parseEgressAllowlist('127.0.0.1')
        );
        expect(seen).toEqual({ method: 'POST', body: 'payload' });
      } finally {
        await closeServer(server);
      }
    });

    test('blocks a redirect to an unparseable Location', async () => {
      const { server, origin } = await startServer((_req, res) => {
        res.writeHead(302, { Location: 'http://[not a host]/x' });
        res.end();
      });
      try {
        await expect(
          fetchWithEgressGuard(origin, {}, parseEgressAllowlist('127.0.0.1'))
        ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
      } finally {
        await closeServer(server);
      }
    });

    test('gives up after too many redirects', async () => {
      const { server, origin } = await startServer((_req, res) => {
        res.writeHead(302, { Location: '/loop' });
        res.end();
      });
      try {
        await expect(
          fetchWithEgressGuard(origin, {}, parseEgressAllowlist('127.0.0.1'))
        ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
      } finally {
        await closeServer(server);
      }
    });

    test('returns a 3xx without a Location header as-is', async () => {
      const { server, origin } = await startServer((_req, res) => {
        res.writeHead(304);
        res.end();
      });
      try {
        const response = await fetchWithEgressGuard(
          origin,
          {},
          parseEgressAllowlist('127.0.0.1')
        );
        expect(response.status).toBe(304);
      } finally {
        await closeServer(server);
      }
    });
  });
});
