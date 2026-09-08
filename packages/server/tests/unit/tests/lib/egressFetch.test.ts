import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { egressGuardedFetch } from 'src/lib/egressFetch';

const startServer = async (
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; origin: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    return server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
};

const closeServer = (server: Server): Promise<void> => {
  return new Promise<void>((resolve) => {
    server.close(() => {
      return resolve();
    });
  });
};

describe('egressGuardedFetch', () => {
  const originalAllowlist = process.env.TOOL_EGRESS_ALLOWED_HOSTS;

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
      return;
    }
    process.env.TOOL_EGRESS_ALLOWED_HOSTS = originalAllowlist;
  });

  test('refuses a loopback destination given as a string', async () => {
    delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
    await expect(
      egressGuardedFetch('http://127.0.0.1:9/models')
    ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
  });

  test('refuses the cloud metadata address given as a URL', async () => {
    delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
    await expect(
      egressGuardedFetch(new URL('http://169.254.169.254/latest/meta-data/'))
    ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
  });

  test('refuses a loopback destination given as a Request', async () => {
    delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
    await expect(
      egressGuardedFetch(
        new Request('http://10.0.0.1/v1/chat', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'hi' }),
        })
      )
    ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
  });

  test('names the destination without calling it a tool target', async () => {
    delete process.env.TOOL_EGRESS_ALLOWED_HOSTS;
    await expect(
      egressGuardedFetch('http://127.0.0.1:9/models')
    ).rejects.toThrow(/^Request target/);
  });

  test('refuses a scheme it does not make requests on', async () => {
    await expect(
      egressGuardedFetch('file:///etc/passwd')
    ).rejects.toMatchObject({ code: 'TOOL_EGRESS_BLOCKED' });
  });

  test('reaches an allowlisted destination and preserves method and body', async () => {
    const received: { method?: string; body?: string; auth?: string } = {};
    const { server, origin } = await startServer((req, res) => {
      received.method = req.method;
      received.auth = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        return chunks.push(chunk);
      });
      req.on('end', () => {
        received.body = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    process.env.TOOL_EGRESS_ALLOWED_HOSTS = '127.0.0.1';

    try {
      const response = await egressGuardedFetch(`${origin}/v1/models`, {
        method: 'POST',
        headers: { authorization: 'Bearer key', 'content-type': 'text/plain' },
        body: 'payload',
      });
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(received).toMatchObject({
        method: 'POST',
        body: 'payload',
        auth: 'Bearer key',
      });
    } finally {
      await closeServer(server);
    }
  });

  test('carries a Request body through to the destination', async () => {
    let body = '';
    const { server, origin } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        return chunks.push(chunk);
      });
      req.on('end', () => {
        body = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(200);
        res.end('done');
      });
    });
    process.env.TOOL_EGRESS_ALLOWED_HOSTS = '127.0.0.1';

    try {
      const response = await egressGuardedFetch(
        new Request(`${origin}/v1/messages`, {
          method: 'POST',
          body: '{"model":"m"}',
        })
      );
      await expect(response.text()).resolves.toBe('done');
      expect(body).toBe('{"model":"m"}');
    } finally {
      await closeServer(server);
    }
  });
});
