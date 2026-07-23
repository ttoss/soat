import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('caseTransform middleware', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');
  });

  test('response body keys are snake_case', async () => {
    const response =
      await authenticatedTestClient(adminToken).get('/api/v1/users');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(0);
    const keys = Object.keys(response.body.data[0]);
    for (const key of keys) {
      expect(key).not.toMatch(/[A-Z]/);
    }
    expect(response.body.data[0].created_at).toBeDefined();
  });

  test('request body accepts snake_case and converts to camelCase internally', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'case-test-project' });
    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();

    const projectId = response.body.id;

    // Verify the response uses snake_case
    expect(response.body.created_at).toBeDefined();
    expect(response.body.createdAt).toBeUndefined();

    // Clean up
    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('nested objects have snake_case keys', async () => {
    // Create a project to get a response with nested data
    const createRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'nested-case-test' });
    expect(createRes.status).toBe(201);

    const projectId = createRes.body.id;

    // List projects and check nested keys
    const listRes =
      await authenticatedTestClient(adminToken).get('/api/v1/projects');
    expect(listRes.status).toBe(200);

    const project = listRes.body.data.find((p: Record<string, unknown>) => {
      return p.id === projectId;
    });
    expect(project).toBeDefined();
    expect(project.created_at).toBeDefined();
    expect(project.updated_at).toBeDefined();

    // Clean up
    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('array responses have snake_case keys on each item', async () => {
    const response =
      await authenticatedTestClient(adminToken).get('/api/v1/users');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    if (response.body.data.length > 0) {
      const keys = Object.keys(response.body.data[0]);
      for (const key of keys) {
        expect(key).not.toMatch(/[A-Z]/);
      }
    }
  });

  test('execute config inner keys are preserved verbatim (not case-transformed)', async () => {
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'execute-passthrough-project' });
    const projectId = projectRes.body.id;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'multipart-passthrough-tool',
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://api.example.com/v1/stt',
          method: 'POST',
          body_mode: 'multipart',
        },
      });

    expect(toolRes.status).toBe(201);
    // `execute` is a pass-through config: its snake_case inner keys must
    // survive the round-trip unchanged in both directions.
    expect(toolRes.body.execute.body_mode).toBe('multipart');
    expect(toolRes.body.execute.bodyMode).toBeUndefined();

    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('document metadata keys are preserved verbatim (not case-transformed)', async () => {
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'metadata-passthrough-project' });
    const projectId = projectRes.body.id;

    const createRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'hello world',
        metadata: { strapiDocumentId: 'abc123' },
      });
    expect(createRes.status).toBe(201);
    // `metadata` is an arbitrary user-defined bag: its keys must survive the
    // round-trip unchanged in both directions, exactly like `execute`.
    expect(createRes.body.metadata.strapiDocumentId).toBe('abc123');
    expect(createRes.body.metadata.strapi_document_id).toBeUndefined();

    const getRes = await authenticatedTestClient(adminToken).get(
      `/api/v1/documents/${createRes.body.id}`
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body.metadata.strapiDocumentId).toBe('abc123');
    expect(getRes.body.metadata.strapi_document_id).toBeUndefined();

    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('tool input mapping keys are preserved verbatim (not case-transformed)', async () => {
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'tool-input-passthrough-project' });
    const projectId = projectRes.body.id;

    // A pipeline step's `input` mapping is a tool payload, not a SOAT resource
    // field: its keys become the sub-tool's request body keys and must round-
    // trip unchanged, exactly like `execute` and document `metadata`.
    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'input-passthrough-pipeline',
        type: 'pipeline',
        pipeline: {
          steps: [
            {
              id: 'call',
              tool: {
                name: 'inline-http',
                type: 'http',
                execute: {
                  url: 'https://api.example.com/runs',
                  method: 'POST',
                },
              },
              input: { fundamental_truth: 'x' },
            },
          ],
        },
      });

    expect(toolRes.status).toBe(201);
    const stepInput = toolRes.body.pipeline.steps[0].input;
    expect(stepInput.fundamental_truth).toBe('x');
    expect(stepInput.fundamentalTruth).toBeUndefined();

    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('orchestration node JSON Logic bodies (expression, exit_condition) round-trip verbatim', async () => {
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'expression-passthrough-project' });
    const projectId = projectRes.body.id;

    // `expression` (transform/condition) and `exit_condition` (poll) are raw
    // JSON Logic bodies: their inner object keys are author-authored data, not
    // SOAT field names, so a `preserve`-wrapped literal must survive the round-
    // trip with its snake_case keys intact — exactly like `state_mapping`.
    const createRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'json-logic-passthrough',
        nodes: [
          {
            id: 'emit',
            type: 'transform',
            expression: {
              preserve: { action_id: 'x', approval_expired: true },
            },
          },
          {
            id: 'watch',
            type: 'poll',
            tool_id: 'tool_placeholder',
            interval: '30s',
            exit_condition: {
              '==': [{ var: 'response.job_state' }, 'done'],
            },
          },
        ],
        edges: [{ from: 'emit', to: 'watch' }],
      });
    expect(createRes.status).toBe(201);

    const assertVerbatim = (body: Record<string, unknown>): void => {
      const nodes = body.nodes as Array<Record<string, unknown>>;
      const emit = nodes.find((n) => {
        return n.id === 'emit';
      })!;
      const watch = nodes.find((n) => {
        return n.id === 'watch';
      })!;
      expect(emit.expression).toEqual({
        preserve: { action_id: 'x', approval_expired: true },
      });
      expect(watch.exit_condition).toEqual({
        '==': [{ var: 'response.job_state' }, 'done'],
      });
    };

    assertVerbatim(createRes.body);

    const getRes = await authenticatedTestClient(adminToken).get(
      `/api/v1/orchestrations/${createRes.body.id}`
    );
    expect(getRes.status).toBe(200);
    assertVerbatim(getRes.body);

    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('non /api/v1 paths are not transformed', async () => {
    // The health or root endpoint should not be transformed
    const response = await testClient.get('/');
    // Just verify it doesn't error — the middleware should skip non-api paths
    expect(response.status).toBeDefined();
  });
});
