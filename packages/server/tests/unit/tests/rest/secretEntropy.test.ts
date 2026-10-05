import crypto from 'node:crypto';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * API keys, trigger secrets and webhook secrets are minted from one source, and
 * API keys are stored as a plain SHA-256. A fast hash is safe only while the
 * input is unguessable, so the entropy every one of them carries is pinned
 * rather than assumed: 32 bytes from the CSPRNG, hex-encoded.
 */

const SECRET = /^[0-9a-f]{64}$/;

describe('Server-minted secrets', () => {
  let adminToken: string;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'secretentropy',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'secret-entropy-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      });
    expect(providerRes.status).toBe(201);
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'secret-entropy-agent',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createApiKey = (name: string) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ name, project_id: projectId });
  };

  describe('POST /api/v1/api-keys', () => {
    test('a key is sk_ and 32 CSPRNG bytes as hex', async () => {
      const randomBytes = jest.spyOn(crypto, 'randomBytes');

      const res = await createApiKey('entropy-key');

      expect(res.status).toBe(201);
      expect(res.body.key.slice(0, 3)).toBe('sk_');
      expect(res.body.key.slice(3)).toMatch(SECRET);
      expect(randomBytes).toHaveBeenCalledWith(32);
    });

    test('two keys never share a value', async () => {
      const first = await createApiKey('entropy-key-a');
      const second = await createApiKey('entropy-key-b');

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.key).not.toBe(second.body.key);
    });
  });

  describe('POST /api/v1/webhooks', () => {
    test('a webhook secret is 32 bytes as hex', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'entropy-webhook',
          url: 'https://example.com/hook',
          events: ['file.created'],
        });

      expect(res.status).toBe(201);
      expect(res.body.secret).toMatch(SECRET);
    });
  });

  describe('POST /api/v1/triggers', () => {
    test('a webhook trigger secret is 32 bytes as hex', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'entropy-trigger',
          type: 'webhook',
          target_type: 'agent',
          target_id: agentId,
        });

      expect(res.status).toBe(201);
      expect(res.body.secret).toMatch(SECRET);
    });
  });
});
