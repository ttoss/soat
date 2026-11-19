import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A formation read masks its credentials as `{ no_echo: true }`. Sending what
 * was read back keeps each stored value under its placeholder, but only in a
 * resource that then equals its deployed declaration.
 */
describe('a deploy resending a masked template', () => {
  let adminToken: string;
  let projectId: string;

  const secretValue = 'sk-stored-secret-kept-under-placeholder';

  const template = (args: { secretName: string; storeDescription: string }) => {
    return {
      resources: {
        Kept: {
          type: 'secret',
          properties: { name: args.secretName, value: secretValue },
        },
        Store: {
          type: 'memory_store',
          properties: { name: 'fss-store', description: args.storeDescription },
        },
      },
    };
  };

  const deploy = async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: `fss-${Date.now()}-${Math.random()}`,
        template: template({ secretName: 'fss-kept', storeDescription: 'a' }),
      });
    expect(res.status).toBe(201);
    const read = await authenticatedTestClient(adminToken).get(
      `/api/v1/formations/${res.body.id}`
    );
    expect(read.body.template.resources.Kept.properties.value).toEqual({
      no_echo: true,
    });
    return { id: res.body.id as string, read: read.body.template };
  };

  const storedTemplate = async (id: string) => {
    const row = await db.Formation.findOne({ where: { publicId: id } });
    return row?.template as {
      resources: Record<string, { properties: Record<string, unknown> }>;
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fss',
      policyActions: ['formations:GetFormation'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  describe('PUT /api/v1/formations/{formation_id}', () => {
    test('a changed resource beside an unchanged masked one deploys, keeping the value', async () => {
      const { id, read } = await deploy();
      read.resources.Store.properties.description = 'b';

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/formations/${id}`)
        .send({ template: read });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
      const stored = await storedTemplate(id);
      expect(stored.resources.Kept.properties.value).toBe(secretValue);
      expect(stored.resources.Store.properties.description).toBe('b');
    });

    test('a masked resource changed beside its placeholder is refused', async () => {
      const { id, read } = await deploy();
      read.resources.Kept.properties.name = 'fss-renamed';

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/formations/${id}`)
        .send({ template: read });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.details).toEqual([
        expect.objectContaining({ path: 'resources.Kept' }),
      ]);
      const stored = await storedTemplate(id);
      expect(stored.resources.Kept.properties.name).toBe('fss-kept');
    });

    test('a placeholder in a resource the formation never deployed is refused', async () => {
      const { id, read } = await deploy();
      read.resources.Other = {
        type: 'secret',
        properties: { name: 'fss-other', value: { no_echo: true } },
      };

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/formations/${id}`)
        .send({ template: read });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.details).toEqual([
        expect.objectContaining({ path: 'resources.Other' }),
      ]);
    });

    test('401 without credentials', async () => {
      const { id, read } = await deploy();
      const res = await authenticatedTestClient('')
        .put(`/api/v1/formations/${id}`)
        .send({ template: read });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/formations', () => {
    test('a create has nothing to keep, so a placeholder is refused', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `fss-create-${Date.now()}`,
          template: {
            resources: {
              Kept: {
                type: 'secret',
                properties: { name: 'fss-new', value: { no_echo: true } },
              },
            },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/formations/plan', () => {
    test('the read template plans as the deployed one does', async () => {
      const { id, read } = await deploy();
      const plan = async (planned: unknown) => {
        const res = await authenticatedTestClient(adminToken)
          .post('/api/v1/formations/plan')
          .send({ project_id: projectId, formation_id: id, template: planned });
        expect(res.status).toBe(200);
        return res.body.changes.map(
          (change: { logical_id: string; action: string }) => {
            return [change.logical_id, change.action];
          }
        );
      };

      const deployed = await plan(
        template({ secretName: 'fss-kept', storeDescription: 'a' })
      );

      expect(await plan(read)).toEqual(deployed);
    });
  });
});
