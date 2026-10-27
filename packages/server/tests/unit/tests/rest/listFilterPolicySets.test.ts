import fs from 'node:fs';

import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A list filter answers what `isAllowed` answers for each row: a credential's
 * boundary intersects its owner's policies, and a statement about another
 * project says nothing about this one.
 */
describe('List filters compile every policy set the caller holds', () => {
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;
  let deniedDocId: string;
  let openDocId: string;

  const createPolicy = async (statement: Array<Record<string, unknown>>) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement } });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createUser = async (args: { username: string; policyId: string }) => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: `${args.username}pass` });
    expect(userRes.status).toBe(201);
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [args.policyId] });
    return loginAs(args.username, `${args.username}pass`);
  };

  const listIds = async (token: string) => {
    const res = await authenticatedTestClient(token)
      .get('/api/v1/documents')
      .query({ project_id: projectId });
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ id: string }>).map((d) => {
      return d.id;
    });
  };

  const exportIds = async (token: string) => {
    const res = await authenticatedTestClient(token)
      .get('/api/v1/documents/export')
      .query({ project_id: projectId })
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        response.on('end', () => {
          callback(null, text);
        });
      });
    expect(res.status).toBe(200);
    return String(res.body)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        return (JSON.parse(line) as { id: string }).id;
      });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'polsetadmin', password: 'supersecret' });
    adminToken = await loginAs('polsetadmin', 'supersecret');

    projectId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Policy Set Project' })
    ).body.id;
    otherProjectId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Policy Set Other Project' })
    ).body.id;

    const createDocument = async (args: {
      path: string;
      tags?: Record<string, string>;
    }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: `Content of ${args.path}`,
          path: args.path,
          tags: args.tags,
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    deniedDocId = await createDocument({
      path: '/policy-sets/denied.txt',
      tags: { team: 'finance' },
    });
    openDocId = await createDocument({ path: '/policy-sets/open.txt' });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('an API key with its own policies', () => {
    let rawKey: string;

    beforeAll(async () => {
      const userPolicyId = await createPolicy([
        { effect: 'Allow', action: ['documents:*'] },
        {
          effect: 'Deny',
          action: ['documents:*'],
          resource: [`srn:${projectId}:document:${deniedDocId}`],
        },
      ]);
      const userToken = await createUser({
        username: 'polsetkeyowner',
        policyId: userPolicyId,
      });
      const keyPolicyId = await createPolicy([
        { effect: 'Allow', action: ['documents:*'] },
      ]);
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Policy Set Key',
          project_id: projectId,
          policy_ids: [keyPolicyId],
        });
      expect(keyRes.status).toBe(201);
      rawKey = keyRes.body.key;
    });

    test('GET /documents keeps the owner Deny', async () => {
      const ids = await listIds(rawKey);
      expect(ids).toContain(openDocId);
      expect(ids).not.toContain(deniedDocId);
    });

    test('GET /documents without project_id keeps the owner Deny', async () => {
      const res =
        await authenticatedTestClient(rawKey).get('/api/v1/documents');
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((d) => {
        return d.id;
      });
      expect(ids).toContain(openDocId);
      expect(ids).not.toContain(deniedDocId);
    });

    test('GET /documents/export keeps the owner Deny', async () => {
      const ids = await exportIds(rawKey);
      expect(ids).toContain(openDocId);
      expect(ids).not.toContain(deniedDocId);
    });

    test('GET /documents/{id} agrees with the listing', async () => {
      const res = await authenticatedTestClient(rawKey).get(
        `/api/v1/documents/${deniedDocId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('a statement naming another project', () => {
    test('a Deny on another project does not empty this listing', async () => {
      const policyId = await createPolicy([
        { effect: 'Allow', action: ['documents:*'] },
        {
          effect: 'Deny',
          action: ['documents:*'],
          resource: [`srn:${otherProjectId}:document:*`],
        },
      ]);
      const token = await createUser({ username: 'polsetdenyother', policyId });

      const ids = await listIds(token);
      expect(ids).toEqual(expect.arrayContaining([openDocId, deniedDocId]));
    });

    test('an Allow on another project grants no row here', async () => {
      const policyId = await createPolicy([
        {
          effect: 'Allow',
          action: ['documents:*'],
          resource: [`srn:${projectId}:document:*`],
          condition: {
            StringNotEquals: { 'soat:ResourceTag/team': 'finance' },
          },
        },
        {
          effect: 'Allow',
          action: ['documents:*'],
          resource: [`srn:${otherProjectId}:document:${deniedDocId}`],
        },
      ]);
      const token = await createUser({
        username: 'polsetallowother',
        policyId,
      });

      expect(await listIds(token)).toEqual([openDocId]);
    });
  });

  test('unauthenticated GET /documents returns 401', async () => {
    const res = await testClient
      .get('/api/v1/documents')
      .query({ project_id: projectId });
    expect(res.status).toBe(401);
  });
});
