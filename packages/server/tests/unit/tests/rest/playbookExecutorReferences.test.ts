import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

type ExecutorType = 'agent' | 'tool' | 'decider' | 'workflow' | 'orchestration';

const MISSING: Record<ExecutorType, string> = {
  agent: 'agt_doesnotexist0000',
  tool: 'tool_doesnotexist000',
  decider: 'dcd_doesnotexist0000',
  workflow: 'wf_doesnotexist00000',
  orchestration: 'orch_doesnotexist000',
};

const definitionOf = (executor: { type: string; id: string }) => {
  return {
    nodes: [
      {
        id: 'run',
        title: 'Run',
        kind: 'execute',
        final: true,
        inputs: [],
        executor,
      },
    ],
  };
};

const codesOf = (problems: { code: string; path: string }[]) => {
  return problems.map(({ code, path }) => {
    return { code, path };
  });
};

describe('Playbook executor references', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let toolId: string;
  let otherToolId: string;
  const existing = {} as Record<ExecutorType, string>;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (
    path: string,
    body: Record<string, unknown>,
    project = projectId
  ) => {
    const res = await asAdmin()
      .post(path)
      .send({ project_id: project, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const httpTool = (project: string) => {
    seq += 1;
    return create(
      '/api/v1/tools',
      {
        name: `ref-tool-${seq}`,
        type: 'http',
        description: 'A tool',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'http://127.0.0.1:9/never', method: 'POST' },
      },
      project
    );
  };

  const createPlaybook = (definition: object, token = adminToken) => {
    seq += 1;
    return authenticatedTestClient(token)
      .post('/api/v1/playbooks')
      .send({ project_id: projectId, name: `refs-${seq}`, definition });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'pbkrefs',
      policyActions: ['playbooks:ValidatePlaybook'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    toolId = await httpTool(projectId);
    otherToolId = await httpTool(otherProjectId);
    const providerId = await create('/api/v1/ai-providers', {
      name: 'refs-provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
    existing.agent = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'refs-agent',
    });
    existing.tool = toolId;
    existing.decider = await create('/api/v1/deciders', {
      name: 'refs-decider',
      tool_id: toolId,
      questions: [
        { type: 'predicate', name: 'escalate', instructions: 'Escalate?' },
      ],
    });
    existing.workflow = await create('/api/v1/workflows', {
      name: 'refs-workflow',
      states: [
        { name: 'open', initial: true },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
    });
    existing.orchestration = await create('/api/v1/orchestrations', {
      name: 'refs-orchestration',
      nodes: [{ id: 'start', type: 'transform', expression: 'done' }],
      edges: [],
    });
  });

  const TYPES = Object.keys(MISSING) as ExecutorType[];

  describe('POST /api/v1/playbooks', () => {
    test.each(TYPES)('accepts an existing %s executor', async (type) => {
      const res = await createPlaybook(
        definitionOf({ type, id: existing[type] })
      );
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^pbk_/);
    });

    test.each(TYPES)('refuses an unknown %s executor', async (type) => {
      const res = await createPlaybook(
        definitionOf({ type, id: MISSING[type] })
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_VALIDATION_FAILED');
      expect(codesOf(res.body.error.meta.problems)).toEqual([
        { code: 'EXECUTOR_NOT_FOUND', path: 'definition.nodes[0].executor.id' },
      ]);
    });

    test('refuses a transformation tool that does not exist', async () => {
      const definition = definitionOf({ type: 'tool', id: toolId });
      const res = await createPlaybook({
        nodes: [
          {
            ...definition.nodes[0],
            transformations: [
              { name: 'doc', format: 'pdf', tool: MISSING.tool },
            ],
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(codesOf(res.body.error.meta.problems)).toEqual([
        {
          code: 'EXECUTOR_NOT_FOUND',
          path: 'definition.nodes[0].transformations[0].tool',
        },
      ]);
    });

    test("refuses another project's tool", async () => {
      const res = await createPlaybook(
        definitionOf({ type: 'tool', id: otherToolId })
      );
      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems[0].code).toBe('EXECUTOR_NOT_FOUND');
    });

    test('answers 403, not 400, to a writer who may not start the missing executor', async () => {
      const token = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'pbkrefsnostart',
        actions: ['playbooks:CreatePlaybook'],
      });
      const res = await createPlaybook(
        definitionOf({ type: 'agent', id: MISSING.agent }),
        token
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTOR_FORBIDDEN');
    });
  });

  describe('PATCH /api/v1/playbooks/{playbook_id}', () => {
    test.each(TYPES)('refuses an unknown %s executor', async (type) => {
      const created = await createPlaybook(
        definitionOf({ type, id: existing[type] })
      );
      expect(created.status).toBe(201);

      const res = await asAdmin()
        .patch(`/api/v1/playbooks/${created.body.id}`)
        .send({ definition: definitionOf({ type, id: MISSING[type] }) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_VALIDATION_FAILED');
      expect(codesOf(res.body.error.meta.problems)).toEqual([
        { code: 'EXECUTOR_NOT_FOUND', path: 'definition.nodes[0].executor.id' },
      ]);
    });
  });

  describe('POST /api/v1/playbooks/validate', () => {
    const validate = (body: Record<string, unknown>, token = adminToken) => {
      return authenticatedTestClient(token)
        .post('/api/v1/playbooks/validate')
        .send(body);
    };

    test.each(TYPES)(
      'reports an unknown %s executor in the named project',
      async (type) => {
        const res = await validate({
          project_id: projectId,
          definition: definitionOf({ type, id: MISSING[type] }),
        });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(codesOf(res.body.problems)).toEqual([
          {
            code: 'EXECUTOR_NOT_FOUND',
            path: 'definition.nodes[0].executor.id',
          },
        ]);
      }
    );

    test.each(TYPES)(
      'answers valid for an existing %s executor',
      async (type) => {
        const res = await validate({
          project_id: projectId,
          definition: definitionOf({ type, id: existing[type] }),
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ valid: true, problems: [] });
      }
    );

    test('reports an unknown upstream playbook in the named project', async () => {
      const res = await validate({
        project_id: projectId,
        definition: {
          upstreams: [{ name: 'intake', playbook_id: 'pbk_doesnotexist000' }],
          nodes: [{ id: 'a', title: 'A', kind: 'collect', inputs: [] }],
        },
      });
      expect(res.status).toBe(200);
      expect(codesOf(res.body.problems)).toEqual([
        {
          code: 'UNKNOWN_UPSTREAM',
          path: 'definition.upstreams[0].playbook_id',
        },
      ]);
    });

    test('checks no reference without a project', async () => {
      const res = await validate({
        definition: definitionOf({ type: 'agent', id: MISSING.agent }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, problems: [] });
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.post('/api/v1/playbooks/validate').send({
        project_id: projectId,
        definition: definitionOf({ type: 'agent', id: MISSING.agent }),
      });
      expect(res.status).toBe(401);
    });

    test('returns 403 for a project the caller may not validate in', async () => {
      const res = await validate(
        {
          project_id: projectId,
          definition: definitionOf({ type: 'agent', id: MISSING.agent }),
        },
        noPermToken
      );
      expect(res.status).toBe(403);
    });
  });
});
