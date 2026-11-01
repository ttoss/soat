import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A provider's credential is its linked secret alone. `config.apiKey` would be
 * stored unencrypted, and ignoring it would leave a `bedrock` or `vertex` record
 * reaching for the deployment's credentials, so every write refuses it.
 */
describe('an AI provider refuses config.apiKey', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let secretId: string;

  const apiKey = 'ABSK-config-key-must-not-leak';

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'apkrefuse',
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

    const secret = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'Bedrock key', value: apiKey });
    expect(secret.status).toBe(201);
    secretId = secret.body.id;
  });

  const expectConfigApiKeyRefusal = (res: {
    status: number;
    body: { error: { code: string; meta: { field: string } } };
  }) => {
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.meta.field).toBe('config.apiKey');
  };

  describe('REST', () => {
    test.each(['bedrock', 'vertex', 'openai'] as const)(
      'create refuses it on a %s provider',
      async (provider) => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/ai-providers')
          .send({
            project_id: projectId,
            name: `Config key ${provider}`,
            provider,
            default_model: 'model-x',
            config: { apiKey, region: 'us-east-1', project: 'p' },
          });

        expectConfigApiKeyRefusal(res);
      }
    );

    test('create refuses it beside a linked secret', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Config key beside secret',
          provider: 'bedrock',
          default_model: 'model-x',
          secret_id: secretId,
          config: { apiKey, region: 'us-east-1' },
        });

      expectConfigApiKeyRefusal(res);
    });

    test('update refuses it', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Secret linked',
          provider: 'bedrock',
          default_model: 'model-x',
          secret_id: secretId,
          config: { region: 'us-east-1' },
        });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ config: { apiKey, region: 'us-east-1' } });

      expectConfigApiKeyRefusal(res);
    });
  });

  // A row the write path never checked: its key stays off every read, and no
  // write keeps it until `config` drops it.
  describe('a stored row carrying it', () => {
    let providerId: string;

    beforeAll(async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const row = await db.AiProvider.create({
        projectId: project!.id,
        secretId: null,
        name: 'Stored config key',
        provider: 'bedrock',
        defaultModel: 'model-x',
        baseUrl: null,
        config: { apiKey, region: 'us-east-1' },
      });
      providerId = row.publicId;
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

    test('an update that keeps it is refused', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${providerId}`)
        .send({ name: 'Renamed' });

      expectConfigApiKeyRefusal(res);
    });

    test('an update that drops it for a secret succeeds', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${providerId}`)
        .send({ secret_id: secretId, config: { region: 'us-east-1' } });

      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ region: 'us-east-1' });
    });
  });

  describe('formations', () => {
    const template = {
      resources: {
        KeyedProvider: {
          type: 'ai_provider',
          properties: {
            name: 'Formation keyed provider',
            provider: 'bedrock',
            default_model: 'model-x',
            config: { apiKey, region: 'us-east-1' },
          },
        },
      },
    };

    test('a create is refused before anything is stored', async () => {
      const name = `apkrefuse-${Date.now()}`;
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({ project_id: projectId, name, template });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        'resources.KeyedProvider.properties.config.apiKey'
      );
      const stored = await db.Formation.count({ where: { name } });
      expect(stored).toBe(0);
    });

    test('a plan is refused', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(apiKey);
    });
  });
});
