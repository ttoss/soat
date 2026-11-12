import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A resource that starts an agent or a tool later is written only by someone
 * who may start it now: on create, on every edit (one that leaves the target
 * untouched included), on a version restore and on a formation apply.
 */
describe('Writer rule: what a resource starts', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let heldAgentId: string;
  let otherAgentId: string;
  let heldToolId: string;
  let otherToolId: string;
  let datasetId: string;
  let memoryStoreId: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };
  const user = () => {
    return authenticatedTestClient(userToken);
  };
  const unique = (base: string) => {
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const expectNotHeld = (
    res: { status: number; body: { error: { code: string; meta: unknown } } },
    target: { type: 'agent' | 'tool'; id: string }
  ) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACTION_NOT_HELD');
    expect(res.body.error.meta).toEqual({
      action:
        target.type === 'agent'
          ? 'agents:CreateAgentGeneration'
          : 'tools:CallTool',
      resource: `srn:${projectId}:${target.type}:${target.id}`,
    });
  };

  const createdId = async (
    request: Promise<{ status: number; body: { id: string } }>
  ) => {
    const res = await request;
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = (name: string, providerId: string) => {
    return createdId(
      admin().post('/api/v1/agents').send({
        project_id: projectId,
        ai_provider_id: providerId,
        name,
      })
    );
  };

  const createTool = (name: string) => {
    return createdId(
      admin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name,
          type: 'http',
          description: 'A server-side tool',
          parameters: { type: 'object', properties: {} },
          execute: { url: 'https://example.com/run', method: 'POST' },
        })
    );
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'writerrulestarts',
      policyActions: [
        'deciders:CreateDecider',
        'deciders:UpdateDecider',
        'deciders:RestoreDeciderVersion',
        'evaluations:CreateEval',
        'guardrails:CreateGuardrail',
        'guardrails:UpdateGuardrail',
        'guardrails:RestoreGuardrailVersion',
        'ingestion-rules:CreateIngestionRule',
        'ingestion-rules:UpdateIngestionRule',
        'memories:CreateMemoryRule',
        'memories:UpdateMemoryRule',
        'formations:CreateFormation',
        'formations:GetFormation',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerId = await createdId(
      admin().post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: 'wrs-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      })
    );
    heldAgentId = await createAgent('wrs-held-agent', providerId);
    otherAgentId = await createAgent('wrs-other-agent', providerId);
    heldToolId = await createTool('wrs-held-tool');
    otherToolId = await createTool('wrs-other-tool');
    datasetId = await createdId(
      admin()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'wrs-dataset' })
    );
    memoryStoreId = await createdId(
      admin()
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'wrs-store' })
    );

    const startPolicyId = await createdId(
      admin()
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['agents:CreateAgentGeneration'],
                resource: [`srn:${projectId}:agent:${heldAgentId}`],
              },
              {
                effect: 'Allow',
                action: ['tools:CallTool'],
                resource: [`srn:${projectId}:tool:${heldToolId}`],
              },
            ],
          },
        })
    );
    const attached = await admin()
      .put(`/api/v1/users/${setup.userId}/policies`)
      .send({ policy_ids: [setup.policyId, startPolicyId] });
    expect(attached.status).toBe(204);
  });

  describe('deciders', () => {
    const QUESTIONS = [
      {
        type: 'choice',
        name: 'route',
        instructions: 'Which team owns this?',
        choices: [
          { value: 'billing', description: 'Charges' },
          { value: 'technical', description: 'Errors' },
        ],
      },
    ];
    const body = (backend: Record<string, string>) => {
      return {
        project_id: projectId,
        name: unique('wrs-decider'),
        questions: QUESTIONS,
        ...backend,
      };
    };

    test('refuses a tool the writer may not call', async () => {
      const res = await user()
        .post('/api/v1/deciders')
        .send(body({ tool_id: otherToolId }));
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('creates one with a tool the writer may call', async () => {
      const res = await user()
        .post('/api/v1/deciders')
        .send(body({ tool_id: heldToolId }));
      expect(res.status).toBe(201);
    });

    test('refuses an edit that leaves the target untouched', async () => {
      const id = await createdId(
        admin()
          .post('/api/v1/deciders')
          .send(body({ tool_id: otherToolId }))
      );
      const res = await user()
        .patch(`/api/v1/deciders/${id}`)
        .send({ name: unique('wrs-renamed') });
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('refuses a version restore', async () => {
      const id = await createdId(
        admin()
          .post('/api/v1/deciders')
          .send(body({ tool_id: otherToolId }))
      );
      const res = await user()
        .post(`/api/v1/deciders/${id}/versions/1/restore`)
        .send({});
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('refuses one a formation declares', async () => {
      const res = await user()
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('wrs-formation'),
          template: {
            resources: {
              Decider: {
                type: 'decider',
                properties: {
                  name: unique('wrs-formation-decider'),
                  tool_id: otherToolId,
                  questions: QUESTIONS,
                },
              },
            },
          },
        });
      expect(res.body.status).not.toBe('active');
      expect(JSON.stringify(res.body)).toContain('ACTION_NOT_HELD');
    });
  });

  describe('evals', () => {
    const body = (fields: Record<string, unknown>) => {
      return {
        project_id: projectId,
        name: unique('wrs-eval'),
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
        ...fields,
      };
    };

    test('refuses an agent the writer may not run', async () => {
      const res = await user()
        .post('/api/v1/evals')
        .send(body({ agent_id: otherAgentId }));
      expectNotHeld(res, { type: 'agent', id: otherAgentId });
    });

    test('refuses a scorer tool the writer may not call', async () => {
      const res = await user()
        .post('/api/v1/evals')
        .send(
          body({
            agent_id: heldAgentId,
            scorers: [{ type: 'tool', name: 'tone', tool_id: otherToolId }],
          })
        );
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('creates one whose agent and scorer tool the writer may start', async () => {
      const res = await user()
        .post('/api/v1/evals')
        .send(
          body({
            agent_id: heldAgentId,
            scorers: [{ type: 'tool', name: 'tone', tool_id: heldToolId }],
          })
        );
      expect(res.status).toBe(201);
    });

    test('refuses an edit that leaves the target untouched', async () => {
      const id = await createdId(
        admin()
          .post('/api/v1/evals')
          .send(body({ agent_id: otherAgentId }))
      );
      const res = await user()
        .put(`/api/v1/evals/${id}`)
        .send({ name: unique('wrs-renamed') });
      expectNotHeld(res, { type: 'agent', id: otherAgentId });
    });
  });

  describe('guardrails', () => {
    const body = (contextToolId: string) => {
      return {
        project_id: projectId,
        name: unique('wrs-guardrail'),
        document: { class: 'B' },
        context_tool_id: contextToolId,
      };
    };

    test('refuses a context tool the writer may not call', async () => {
      const res = await user()
        .post('/api/v1/guardrails')
        .send(body(otherToolId));
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('creates one with a context tool the writer may call', async () => {
      const res = await user()
        .post('/api/v1/guardrails')
        .send(body(heldToolId));
      expect(res.status).toBe(201);
    });

    test('refuses an edit that leaves the target untouched', async () => {
      const id = await createdId(
        admin().post('/api/v1/guardrails').send(body(otherToolId))
      );
      const res = await user()
        .patch(`/api/v1/guardrails/${id}`)
        .send({ name: unique('wrs-renamed') });
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('refuses a version restore', async () => {
      const id = await createdId(
        admin().post('/api/v1/guardrails').send(body(otherToolId))
      );
      const res = await user()
        .post(`/api/v1/guardrails/${id}/versions/1/restore`)
        .send({});
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });
  });

  describe('ingestion rules', () => {
    const body = (toolId: string) => {
      return {
        project_id: projectId,
        content_type_glob: `image/${unique('x')}`,
        tool_id: toolId,
        file_delivery: 'base64',
      };
    };

    test('refuses a converter tool the writer may not call', async () => {
      const res = await user()
        .post('/api/v1/ingestion-rules')
        .send(body(otherToolId));
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('creates one with a converter tool the writer may call', async () => {
      const res = await user()
        .post('/api/v1/ingestion-rules')
        .send(body(heldToolId));
      expect(res.status).toBe(201);
    });

    test('refuses an edit that leaves the target untouched', async () => {
      const id = await createdId(
        admin().post('/api/v1/ingestion-rules').send(body(otherToolId))
      );
      const res = await user()
        .patch(`/api/v1/ingestion-rules/${id}`)
        .send({ chunk_size: 500 });
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });
  });

  describe('memory rules', () => {
    const body = (handler: Record<string, string>) => {
      return {
        memory_store_id: memoryStoreId,
        on: 'generations.completed',
        ...handler,
      };
    };

    test('refuses a handler agent the writer may not run', async () => {
      const res = await user()
        .post('/api/v1/memory-rules')
        .send(body({ agent_id: otherAgentId }));
      expectNotHeld(res, { type: 'agent', id: otherAgentId });
    });

    test('refuses a handler tool the writer may not call', async () => {
      const res = await user()
        .post('/api/v1/memory-rules')
        .send(body({ tool_id: otherToolId }));
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });

    test('creates one with a handler tool the writer may call', async () => {
      const res = await user()
        .post('/api/v1/memory-rules')
        .send(body({ tool_id: heldToolId }));
      expect(res.status).toBe(201);
    });

    test('refuses an edit that leaves the target untouched', async () => {
      const id = await createdId(
        admin()
          .post('/api/v1/memory-rules')
          .send(body({ tool_id: otherToolId }))
      );
      const res = await user()
        .patch(`/api/v1/memory-rules/${id}`)
        .send({ enabled: false });
      expectNotHeld(res, { type: 'tool', id: otherToolId });
    });
  });
});
