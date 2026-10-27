import { db } from 'src/db';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `config.apiKey` is a credential a provider record can carry instead of a
 * linked secret. Reading a provider needs only `ai-providers:GetAiProvider`,
 * and reading a formation only `formations:GetFormation`, so no read surface
 * may hand the key back.
 */
describe('an AI provider never echoes config.apiKey', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  const apiKey = 'ABSK-config-key-must-not-leak';

  const createProvider = (name: string) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name,
        provider: 'bedrock',
        default_model: 'model-x',
        config: { apiKey, region: 'us-east-1' },
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'apkecho',
      policyActions: [
        'ai-providers:ListAiProviders',
        'ai-providers:GetAiProvider',
        'ai-providers:CreateAiProvider',
        'ai-providers:UpdateAiProvider',
        'formations:GetFormation',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('REST', () => {
    let providerId: string;

    test('the create response masks the key it was just given', async () => {
      const res = await createProvider('Config Key Create');

      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
      expect(res.body.config.apiKey).toEqual({ no_echo: true });
      expect(res.body.config.region).toBe('us-east-1');
      providerId = res.body.id;
    });

    test('a read masks the key', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${providerId}`
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
      expect(res.body.config.apiKey).toEqual({ no_echo: true });
    });

    test('a list masks the key', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/ai-providers')
        .query({ project_id: projectId });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
    });

    test('an update response masks the key', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${providerId}`)
        .send({ name: 'Config Key Renamed' });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
      expect(res.body.config.apiKey).toEqual({ no_echo: true });
    });

    test('writing the mask back is refused, not stored as the key', async () => {
      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${providerId}`
      );

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${providerId}`)
        .send({ config: read.body.config });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.field).toBe('config.apiKey');
    });

    test('generation still reads the stored key', async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const resolved = await resolveAiProviderSecret({
        aiProviderId: providerId,
        projectId: project!.id,
      });

      expect(resolved?.config?.apiKey).toBe(apiKey);
    });
  });

  describe('formations', () => {
    const template = (name: string) => {
      return {
        resources: {
          KeyedProvider: {
            type: 'ai_provider',
            properties: {
              name,
              provider: 'bedrock',
              default_model: 'model-x',
              config: { apiKey, region: 'us-east-1' },
            },
          },
        },
      };
    };

    test('a stored template read masks the key', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `apkecho-${Date.now()}`,
          template: template('Formation Keyed Provider'),
        });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain(apiKey);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations/${created.body.id}`
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
      const { config } = res.body.template.resources.KeyedProvider.properties;
      expect(config.apiKey).toEqual({ no_echo: true });
      expect(config.region).toBe('us-east-1');
    });

    test('a plan diff masks the key', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: template('Planned') });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
    });
  });
});
