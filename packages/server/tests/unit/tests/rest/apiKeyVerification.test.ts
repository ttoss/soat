import { createHash } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { db } from 'src/db';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const sha256 = (value: string) => {
  return createHash('sha256').update(value).digest('hex');
};

const mcpRequest = (args: { key: string; body: Record<string, unknown> }) => {
  return testClient
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${args.key}`)
    .send({ jsonrpc: '2.0', id: 1, ...args.body });
};

const mcpToolsList = (key: string) => {
  return mcpRequest({ key, body: { method: 'tools/list', params: {} } });
};

const mcpListProjects = (key: string) => {
  return mcpRequest({
    key,
    body: {
      method: 'tools/call',
      params: { name: 'list-projects', arguments: {} },
    },
  });
};

describe('API key verification', () => {
  let adminToken: string;
  let adminUserId: number;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'keyverifier', password: 'keyverifierpass' });
    adminToken = await loginAs('keyverifier', 'keyverifierpass');

    const admin = await db.User.findOne({ where: { username: 'keyverifier' } });
    adminUserId = admin!.id as number;

    const projRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Key Verification Project' });
    projectId = projRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mintKey = async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'verified-key', project_id: projectId });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, key: res.body.key as string };
  };

  /** A key stored the way keys minted before the SHA-256 column are. */
  const seedLegacyKey = async () => {
    const key = `sk_${'a1'.repeat(32)}${Date.now()}`;
    const row = await db.ApiKey.create({
      userId: adminUserId,
      projectId: null,
      name: 'legacy-key',
      keyPrefix: key.slice(0, 8),
      keyHash: await bcrypt.hash(key, 4),
      policyIds: [],
    });
    return { id: row.publicId as string, key };
  };

  const storedHashes = async (publicId: string) => {
    const row = await db.ApiKey.findOne({ where: { publicId } });
    return {
      keyHash: row?.keyHash ?? null,
      keyHashSha256: row?.keyHashSha256 ?? null,
    };
  };

  describe('a minted key', () => {
    test('is stored as its SHA-256 alone', async () => {
      const { id, key } = await mintKey();

      expect(await storedHashes(id)).toEqual({
        keyHash: null,
        keyHashSha256: sha256(key),
      });
    });

    test('is minted without bcrypt', async () => {
      const hash = jest.spyOn(bcrypt, 'hash');

      await mintKey();

      expect(hash).not.toHaveBeenCalled();
    });

    test('verifies on REST without bcrypt', async () => {
      const { key } = await mintKey();
      const compare = jest.spyOn(bcrypt, 'compare');

      const res = await authenticatedTestClient(key).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(compare).not.toHaveBeenCalled();
    });

    test('verifies on MCP, gate and forwarded call alike, without bcrypt', async () => {
      const { key } = await mintKey();
      const compare = jest.spyOn(bcrypt, 'compare');

      const list = await mcpToolsList(key);
      const call = await mcpListProjects(key);

      expect(list.status).toBe(200);
      expect(call.status).toBe(200);
      expect(call.body.result.isError).toBeFalsy();
      expect(compare).not.toHaveBeenCalled();
    });
  });

  describe('a legacy bcrypt key', () => {
    test('verifies on REST and gains its SHA-256', async () => {
      const { id, key } = await seedLegacyKey();
      const compare = jest.spyOn(bcrypt, 'compare');

      const res = await authenticatedTestClient(key).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(compare).toHaveBeenCalledTimes(1);
      expect((await storedHashes(id)).keyHashSha256).toBe(sha256(key));
    });

    test('takes the fast path on its next request', async () => {
      const { key } = await seedLegacyKey();
      await authenticatedTestClient(key).get('/api/v1/projects');
      const compare = jest.spyOn(bcrypt, 'compare');

      const res = await authenticatedTestClient(key).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(compare).not.toHaveBeenCalled();
    });

    test('verifies at the MCP gate and gains its SHA-256', async () => {
      const { id, key } = await seedLegacyKey();

      const res = await mcpToolsList(key);

      expect(res.status).toBe(200);
      expect((await storedHashes(id)).keyHashSha256).toBe(sha256(key));
    });

    test('a wrong key sharing its prefix is refused and writes nothing', async () => {
      const { id, key } = await seedLegacyKey();
      const impostor = `${key.slice(0, 8)}${'f'.repeat(64)}`;

      const res =
        await authenticatedTestClient(impostor).get('/api/v1/projects');

      expect(res.status).toBe(401);
      expect((await storedHashes(id)).keyHashSha256).toBeNull();
    });
  });

  describe('a deleted key', () => {
    test('is refused on REST', async () => {
      const { id, key } = await mintKey();
      expect(
        (await authenticatedTestClient(key).get('/api/v1/projects')).status
      ).toBe(200);

      await authenticatedTestClient(adminToken).delete(
        `/api/v1/api-keys/${id}`
      );

      expect(
        (await authenticatedTestClient(key).get('/api/v1/projects')).status
      ).toBe(401);
    });

    test('is refused on MCP', async () => {
      const { id, key } = await mintKey();
      expect((await mcpToolsList(key)).status).toBe(200);

      await authenticatedTestClient(adminToken).delete(
        `/api/v1/api-keys/${id}`
      );

      expect((await mcpToolsList(key)).status).toBe(401);
    });
  });
});
