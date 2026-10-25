import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A resource addressed by id from outside its project answers exactly what a
 * made-up id answers: the caller named the resource, never its project, so a
 * `403` — or a message naming that project — confirms it exists.
 *
 * Rows span both refusal paths: `authorizeResource` and the routes that
 * authorize a loaded resource themselves through `resourceRefusal`.
 */
describe('a by-id resource in another project', () => {
  let adminToken: string;
  let scopedKey: string;
  let projectUserToken: string;
  const resourceIds: Record<string, string> = {};

  const ROUTES: {
    module: string;
    method: 'get' | 'patch' | 'delete';
    path: (id: string) => string;
    missingId: string;
  }[] = [
    {
      module: 'tools',
      method: 'get',
      path: (id) => {
        return `/api/v1/tools/${id}`;
      },
      missingId: 'tool_missing0000000000',
    },
    {
      module: 'tools',
      method: 'delete',
      path: (id) => {
        return `/api/v1/tools/${id}`;
      },
      missingId: 'tool_missing0000000000',
    },
    {
      module: 'secrets',
      method: 'get',
      path: (id) => {
        return `/api/v1/secrets/${id}`;
      },
      missingId: 'sec_missing00000000000',
    },
    {
      module: 'ai-providers',
      method: 'get',
      path: (id) => {
        return `/api/v1/ai-providers/${id}`;
      },
      missingId: 'aip_missing00000000000',
    },
    {
      module: 'ai-providers',
      method: 'delete',
      path: (id) => {
        return `/api/v1/ai-providers/${id}`;
      },
      missingId: 'aip_missing00000000000',
    },
    {
      module: 'memory-stores',
      method: 'get',
      path: (id) => {
        return `/api/v1/memory-stores/${id}`;
      },
      missingId: 'mst_missing00000000000',
    },
    {
      module: 'conversations',
      method: 'get',
      path: (id) => {
        return `/api/v1/conversations/${id}`;
      },
      missingId: 'conv_missing0000000000',
    },
  ];

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'xprojbyid',
      policyActions: ['*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    const ownProject = setup.projectId;
    const resourceProject = setup.otherProjectId!;

    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ project_id: ownProject, name: 'xprojbyid scoped key' });
    scopedKey = keyRes.body.key;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['*'],
              resource: [`srn:${ownProject}:*:*`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${setup.userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });
    projectUserToken = setup.userToken;

    const admin = authenticatedTestClient(adminToken);
    const create = async (path: string, body: object) => {
      const res = await admin
        .post(path)
        .send({ project_id: resourceProject, ...body });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    resourceIds.tools = await create('/api/v1/tools', {
      name: 'xprojbyid-tool',
      type: 'http',
      description: 'A tool in another project',
      execute: { url: 'https://example.invalid' },
    });
    resourceIds.secrets = await create('/api/v1/secrets', {
      name: 'xprojbyid-secret',
      value: 'shh',
    });
    resourceIds['ai-providers'] = await create('/api/v1/ai-providers', {
      name: 'xprojbyid-provider',
      provider: 'ollama',
      default_model: 'model-x',
    });
    resourceIds['memory-stores'] = await create('/api/v1/memory-stores', {
      name: 'xprojbyid-store',
    });
    resourceIds.conversations = await create('/api/v1/conversations', {});
  });

  const callers = [
    {
      name: 'a key scoped to another project',
      token: () => {
        return scopedKey;
      },
    },
    {
      name: 'a user whose policies name only another project',
      token: () => {
        return projectUserToken;
      },
    },
  ];

  describe.each(callers)('$name', ({ token }) => {
    test.each(ROUTES)(
      '$method $module answers as a made-up id does',
      async ({ module, method, path, missingId }) => {
        const client = authenticatedTestClient(token());
        const missing = await client[method](path(missingId)).send({});
        const res = await client[method](path(resourceIds[module])).send({});

        expect(missing.status).toBe(404);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe(missing.body.error.code);
        expect(JSON.stringify(res.body)).not.toContain('proj_');
      }
    );
  });
});
