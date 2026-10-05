import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A `workflow` resource authored in a template: snake_case nested keys
 * (`on_enter`, `agent_id`, `stalled_after`) are stored camelCase and read back
 * snake_case, a JSON-Logic guard round-trips verbatim, and the module's
 * fetch/read pair is what lets `plan` diff the live workflow.
 */
describe('Formation with workflow resources', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;
  let formationSeq = 0;

  const GUARD = { '==': [{ var: 'task.payload.approved' }, true] };

  const workflowProperties = (name: string) => {
    return {
      name,
      description: 'authored in a template',
      states: [
        { name: 'todo', initial: true, kind: 'human', stalled_after: 60 },
        {
          name: 'working',
          on_enter: {
            dispatch: { kind: 'agent', agent_id: agentId },
            on_complete: [
              {
                when: { '==': [{ var: 'result.ok' }, true] },
                transition: 'finish',
              },
            ],
          },
        },
        { name: 'done', terminal: true },
      ],
      transitions: [
        { name: 'start', from: ['todo'], to: 'working' },
        { name: 'finish', from: ['working'], to: 'done', guard: GUARD },
      ],
      payload_schema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
      },
    };
  };

  const templateOf = (properties: Record<string, unknown>) => {
    return {
      resources: { Flow: { type: 'workflow', properties } },
      outputs: { workflowId: { ref: 'Flow' } },
    };
  };

  /** Deploys a one-workflow formation; returns its id and the workflow's. */
  const deploy = async (properties: Record<string, unknown>) => {
    formationSeq += 1;
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: `workflow-formation-${formationSeq}`,
        template: templateOf(properties),
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    return {
      formationId: res.body.id as string,
      workflowId: res.body.resources[0].physical_resource_id as string,
    };
  };

  const getWorkflow = (workflowId: string) => {
    return authenticatedTestClient(userToken).get(
      `/api/v1/workflows/${workflowId}`
    );
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'wfform',
      policyActions: [
        'formations:ValidateFormation',
        'formations:PlanFormation',
        'formations:CreateFormation',
        'formations:GetFormation',
        'formations:UpdateFormation',
        'formations:DeleteFormation',
        'workflows:CreateWorkflow',
        'workflows:GetWorkflow',
        'workflows:UpdateWorkflow',
        'workflows:DeleteWorkflow',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    const admin = authenticatedTestClient(setup.adminToken);
    const providerRes = await admin.post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'WFFormProvider',
      provider: 'openai',
      default_model: 'gpt-4o',
    });
    expect(providerRes.status).toBe(201);
    const agentRes = await admin.post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'WF Form Agent',
    });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  describe('POST /api/v1/formations/validate', () => {
    const validate = (properties: unknown) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: { resources: { Flow: { type: 'workflow', properties } } },
        });
    };

    test('a non-object properties bag is invalid', async () => {
      const res = await validate('nope');
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('a bag missing states and transitions is invalid', async () => {
      const res = await validate({ name: 'incomplete' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('an unknown field is named in the error', async () => {
      const res = await validate({
        name: 'wf',
        states: [{ name: 'a', initial: true }],
        transitions: [],
        bogus: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((error: { message: string }) => {
          return error.message.includes('bogus');
        })
      ).toBe(true);
    });
  });

  describe('POST /api/v1/formations', () => {
    test('creates the workflow with its nested keys and guard intact', async () => {
      const { workflowId } = await deploy(workflowProperties('Created flow'));
      expect(workflowId).toMatch(/^wfl_/);

      const res = await getWorkflow(workflowId);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Created flow');
      expect(res.body.states[0]).toMatchObject({
        name: 'todo',
        stalled_after: 60,
      });
      expect(res.body.states[1].on_enter.dispatch).toEqual({
        kind: 'agent',
        agent_id: agentId,
      });
      expect(res.body.transitions[1].guard).toEqual(GUARD);
    });

    test('an invalid definition fails the resource', async () => {
      formationSeq += 1;
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `workflow-formation-invalid-${formationSeq}`,
          template: templateOf({
            name: 'two initials',
            states: [
              { name: 'a', initial: true },
              { name: 'b', initial: true },
            ],
            transitions: [],
          }),
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.resources[0].status).toBe('failed');
      expect(res.body.resources[0].physical_resource_id).toBeNull();
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.post('/api/v1/formations').send({
        project_id: projectId,
        name: 'workflow-formation-anon',
        template: templateOf(workflowProperties('Anonymous flow')),
      });
      expect(res.status).toBe(401);
    });

    test('returns 403 for a caller who may not create workflows', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'workflow-formation-noperm',
          template: templateOf(workflowProperties('Forbidden flow')),
        });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/formations/plan', () => {
    const plan = (args: {
      formationId: string;
      properties: Record<string, unknown>;
    }) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: args.formationId,
          template: templateOf(args.properties),
        });
    };

    test('an unchanged workflow plans as a no-op', async () => {
      const properties = workflowProperties('Planned flow');
      const { formationId } = await deploy(properties);

      const res = await plan({ formationId, properties });
      expect(res.status).toBe(200);
      expect(res.body.changes[0].action).toBe('no-op');
    });

    test('a workflow deleted out of band plans as an update with no current state', async () => {
      const properties = workflowProperties('Drifted flow');
      const { formationId, workflowId } = await deploy(properties);
      const deleted = await authenticatedTestClient(userToken).delete(
        `/api/v1/workflows/${workflowId}`
      );
      expect(deleted.status).toBe(204);

      const res = await plan({ formationId, properties });
      expect(res.status).toBe(200);
      expect(res.body.changes[0].action).toBe('update');
      expect(res.body.changes[0].diff.current).toBeNull();
    });
  });

  describe('PUT /api/v1/formations/:formation_id', () => {
    test('updates the workflow in place', async () => {
      const { formationId, workflowId } = await deploy(
        workflowProperties('Flow before update')
      );

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formationId}`)
        .send({
          template: templateOf({
            name: 'Flow after update',
            states: [{ name: 'solo', initial: true }],
            transitions: [],
          }),
        });
      expect(res.status).toBe(200);

      const workflow = await getWorkflow(workflowId);
      expect(workflow.status).toBe(200);
      expect(workflow.body.name).toBe('Flow after update');
      expect(workflow.body.states).toEqual([{ name: 'solo', initial: true }]);
    });
  });

  describe('DELETE /api/v1/formations/:formation_id', () => {
    test('deletes the workflow with the formation', async () => {
      const { formationId, workflowId } = await deploy(
        workflowProperties('Flow to delete')
      );

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formationId}`
      );
      expect(res.status).toBe(200);

      const workflow = await getWorkflow(workflowId);
      expect(workflow.status).toBe(404);
    });
  });
});
