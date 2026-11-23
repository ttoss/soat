import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('A loop node’s input_mapping', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let echoChildId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createOrchestration = (body: Record<string, unknown>) => {
    return client()
      .post('/api/v1/orchestrations')
      .send({ project_id: projectId, edges: [], ...body });
  };

  const loopNode = (extra: Record<string, unknown>) => {
    return {
      id: 'fan',
      type: 'loop',
      orchestration_id: echoChildId,
      collection: 'state.input.docs',
      item_variable: 'doc',
      state_mapping: { 'state.results': { var: 'output.results' } },
      ...extra,
    };
  };

  const expectRefused = (res: {
    status: number;
    body: { error: { code: string; meta: { problems: { path: string }[] } } };
  }) => {
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    expect(res.body.error.meta.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'nodes[0].input_mapping.doc' }),
      ])
    );
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'loopinputmap',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:GetOrchestration',
        'orchestrations:UpdateOrchestration',
        'orchestrations:ValidateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'formations:*',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const child = await createOrchestration({
      name: 'Echo Child',
      nodes: [{ id: 'noop', type: 'transform', expression: 1 }],
      output_mapping: { seen: { var: 'state.input' } },
    });
    expect(child.status).toBe(201);
    echoChildId = child.body.id;
  });

  test('each child reads a parent state field beside its item', async () => {
    const created = await createOrchestration({
      name: 'Mapped Fan-out',
      input_schema: {
        type: 'object',
        properties: { actor: { type: 'string' }, docs: { type: 'array' } },
      },
      nodes: [
        loopNode({
          input_mapping: {
            actor: { var: 'input.actor' },
            title: { var: 'doc.title' },
          },
        }),
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.nodes[0].input_mapping).toEqual({
      actor: { var: 'input.actor' },
      title: { var: 'doc.title' },
    });

    const run = await client()
      .post('/api/v1/orchestration-runs')
      .send({
        wait: true,
        orchestration_id: created.body.id,
        input: { actor: 'usr_1', docs: [{ title: 'a' }, { title: 'b' }] },
      });

    expect(run.status).toBe(201);
    expect(run.body.status).toBe('completed');
    expect(run.body.state.results).toEqual([
      { seen: { doc: { title: 'a' }, actor: 'usr_1', title: 'a' } },
      { seen: { doc: { title: 'b' }, actor: 'usr_1', title: 'b' } },
    ]);
  });

  test('without input_mapping a child receives only its item', async () => {
    const created = await createOrchestration({
      name: 'Bare Fan-out',
      nodes: [loopNode({})],
    });
    expect(created.status).toBe(201);

    const run = await client()
      .post('/api/v1/orchestration-runs')
      .send({
        wait: true,
        orchestration_id: created.body.id,
        input: { docs: [{ title: 'a' }] },
      });

    expect(run.status).toBe(201);
    expect(run.body.state.results).toEqual([{ seen: { doc: { title: 'a' } } }]);
  });

  test('a key equal to item_variable is refused on create', async () => {
    const res = await createOrchestration({
      name: 'Colliding Fan-out',
      nodes: [loopNode({ input_mapping: { doc: { var: 'input.actor' } } })],
    });

    expectRefused(res);
  });

  test('a key equal to the default item_variable is refused', async () => {
    const res = await createOrchestration({
      name: 'Default Colliding Fan-out',
      nodes: [
        loopNode({
          item_variable: undefined,
          input_mapping: { item: { var: 'input.actor' } },
        }),
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.meta.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'nodes[0].input_mapping.item' }),
      ])
    );
  });

  test('a key equal to item_variable is refused on update', async () => {
    const created = await createOrchestration({
      name: 'Patched Fan-out',
      nodes: [loopNode({})],
    });
    expect(created.status).toBe(201);

    const res = await client()
      .patch(`/api/v1/orchestrations/${created.body.id}`)
      .send({
        nodes: [loopNode({ input_mapping: { doc: 'x' } })],
        edges: [],
      });

    expectRefused(res);
  });

  test('a formation applying a colliding key is refused the same way', async () => {
    const res = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'colliding-loop',
        template: {
          resources: {
            Fan: {
              type: 'orchestration',
              properties: {
                name: 'Formation Colliding Fan-out',
                nodes: [loopNode({ input_mapping: { doc: 'x' } })],
                edges: [],
              },
            },
          },
        },
      });

    // A deploy answers 2xx; the refusal is the formation's failure.
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
  });

  describe('reachability', () => {
    const declaredInput = {
      type: 'object',
      properties: { actor: { type: 'string' } },
    };

    test('a reference to the item variable is satisfied', async () => {
      const res = await client()
        .post('/api/v1/orchestrations/validate')
        .send({
          input_schema: declaredInput,
          edges: [],
          nodes: [loopNode({ input_mapping: { title: { var: 'doc.title' } } })],
        });

      expect(res.status).toBe(200);
      expect(res.body.problems).toEqual([]);
    });

    test('a state key no upstream node writes is refused', async () => {
      const res = await client()
        .post('/api/v1/orchestrations/validate')
        .send({
          input_schema: declaredInput,
          edges: [],
          nodes: [loopNode({ input_mapping: { owner: { var: 'ghost' } } })],
        });

      expect(res.status).toBe(200);
      expect(res.body.problems).toEqual([
        expect.objectContaining({
          code: 'UNWRITTEN_STATE_KEY',
          path: 'nodes[0].input_mapping.owner',
        }),
      ]);
    });
  });

  test('401 without a token', async () => {
    const res = await testClient.post('/api/v1/orchestrations').send({
      project_id: projectId,
      name: 'Anon Fan-out',
      edges: [],
      nodes: [loopNode({ input_mapping: { actor: 'x' } })],
    });
    expect(res.status).toBe(401);
  });

  test('a caller without permission cannot create one', async () => {
    const res = await authenticatedTestClient(noPermToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'NoPerm Fan-out',
        edges: [],
        nodes: [loopNode({ input_mapping: { actor: 'x' } })],
      });
    expect(res.status).toBe(403);
  });
});
