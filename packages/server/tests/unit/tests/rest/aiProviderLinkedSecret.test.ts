import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// A linked secret declares a credential of the record's own, so one that holds
// none is refused even where the deployment's may be used: the deployment's is
// a fallback only for a record that links nothing.
describe('AI provider linking a secret that holds no usable credential', () => {
  const previous = process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS;
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS = 'true';
    const setup = await setupProjectWithUsers({
      prefix: 'aiprovlinked',
      policyActions: [
        'ai-providers:CreateAiProvider',
        'ai-providers:UpdateAiProvider',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  afterAll(() => {
    if (previous === undefined) {
      delete process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS;
    } else {
      process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS = previous;
    }
  });

  const createSecret = async (value: string) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: `Secret ${value}`, value });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  describe('POST /api/v1/ai-providers', () => {
    test.each([
      ['bedrock', 'not-a-credential'],
      ['bedrock', '{"accessKeyId":"AKIAIOSFODNN7EXAMPLE"}'],
      ['vertex', '{"project_id":"p"}'],
    ] as const)('refuses a %s provider linking %p', async (provider, value) => {
      const secretId = await createSecret(value);
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: `Unusable ${provider}`,
          provider,
          default_model: 'model-x',
          secret_id: secretId,
          config: { project: 'p' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
    });

    test('accepts a bedrock provider linking a bearer token', async () => {
      const secretId = await createSecret('ABSKexample');
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Bedrock Bearer',
          provider: 'bedrock',
          default_model: 'model-x',
          secret_id: secretId,
        });

      expect(response.status).toBe(201);
      expect(response.body.secret_id).toBe(secretId);
    });
  });

  describe('PATCH /api/v1/ai-providers/:ai_provider_id', () => {
    test('refuses linking one to a bedrock provider', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Bedrock Relinked',
          provider: 'bedrock',
          default_model: 'model-x',
        });
      expect(created.status).toBe(201);
      const secretId = await createSecret('{"apiKey":""}');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ secret_id: secretId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
    });
  });
});
