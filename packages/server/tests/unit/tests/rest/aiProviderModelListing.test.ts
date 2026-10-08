import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A vendor answers its whole catalogue in one call; `q`, `limit` and `offset`
 * narrow and page what it returned. A local server stands in for the vendor's
 * `GET /models`.
 */
describe('GET /api/v1/ai-providers/:ai_provider_id/models paging', () => {
  let catalogueServer: Server;
  let userToken: string;
  let providerId: string;
  const catalogue = [
    { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    { id: 'claude-3-7-sonnet', display_name: 'Claude Sonnet 3.7' },
  ];

  const list = (query: Record<string, string | number> = {}) => {
    return authenticatedTestClient(userToken)
      .get(`/api/v1/ai-providers/${providerId}/models`)
      .query(query);
  };

  const ids = (body: { data: Array<{ id: string }> }) => {
    return body.data.map((model) => {
      return model.id;
    });
  };

  beforeAll(async () => {
    catalogueServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: catalogue }));
    });
    await new Promise<void>((resolve) => {
      catalogueServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = catalogueServer.address() as AddressInfo;

    const setup = await setupProjectWithUsers({
      prefix: 'aipmodels',
      policyActions: [
        'ai-providers:CreateAiProvider',
        'ai-providers:ListAiProviderModels',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;

    const secretRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/secrets')
      .send({
        project_id: setup.projectId,
        name: 'Catalogue Key',
        value: 'sk-ant-test',
      });
    const providerRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'Catalogue Listing',
        provider: 'anthropic',
        default_model: 'claude-sonnet-4-5',
        base_url: `http://127.0.0.1:${port}/v1`,
        secret_id: secretRes.body.id,
      });
    expect(providerRes.status).toBe(201);
    providerId = providerRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      catalogueServer.close(() => {
        resolve();
      });
    });
  });

  test('the default page carries the catalogue and the envelope', async () => {
    const response = await list();

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'data',
      'limit',
      'offset',
      'total',
    ]);
    expect(response.body).toMatchObject({ total: 4, limit: 50, offset: 0 });
    expect(ids(response.body)).toEqual(
      catalogue.map((model) => {
        return model.id;
      })
    );
  });

  test('an explicit page answers that slice', async () => {
    const response = await list({ limit: 2, offset: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 4, limit: 2, offset: 1 });
    expect(ids(response.body)).toEqual(['claude-opus-4-1', 'claude-haiku-4-5']);
  });

  test('the last page holds the remainder', async () => {
    const response = await list({ limit: 3, offset: 3 });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(4);
    expect(ids(response.body)).toEqual(['claude-3-7-sonnet']);
  });

  test('a limit above the ceiling is clamped to it', async () => {
    const response = await list({ limit: 1000 });

    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(100);
  });

  test('a non-numeric limit is refused', async () => {
    const response = await list({ limit: 'abc' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('q matches id or display name, ignoring case', async () => {
    const response = await list({ q: 'SONNET' });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(ids(response.body)).toEqual([
      'claude-sonnet-4-5',
      'claude-3-7-sonnet',
    ]);
  });

  test('q matches a display name the id does not carry', async () => {
    const response = await list({ q: 'opus 4.1' });

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual(['claude-opus-4-1']);
  });

  test('q filters before paging', async () => {
    const response = await list({ q: 'sonnet', limit: 1, offset: 1 });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(ids(response.body)).toEqual(['claude-3-7-sonnet']);
  });

  test('a q nothing matches answers an empty page', async () => {
    const response = await list({ q: 'gpt' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: [], total: 0 });
  });
});
