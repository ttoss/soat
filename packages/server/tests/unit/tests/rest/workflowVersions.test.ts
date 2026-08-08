import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Workflow state-machine version history (issue #882).
 *
 * The archive mechanics are shared with agents, guardrails and orchestrations
 * (`resourceVersions.ts`); what is workflow-specific — and what these tests pin —
 * is *which* slice of a workflow counts as configuration, that the write path
 * archives it on create and on every definition change, and that restore appends
 * rather than rewinds.
 */

const WORKFLOW_VERSION_ACTIONS = [
  'workflows:CreateWorkflow',
  'workflows:GetWorkflow',
  'workflows:UpdateWorkflow',
  'workflows:DeleteWorkflow',
  'workflows:ListWorkflowVersions',
  'workflows:GetWorkflowVersion',
  'workflows:RestoreWorkflowVersion',
  'tasks:CreateTask',
  'agents:CreateAgent',
  'agents:DeleteAgent',
  'ai-providers:CreateAiProvider',
  'policies:CreatePolicy',
  'api-keys:CreateApiKey',
];

describe('Workflow versions', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;
  let workflowSeq = 0;

  const STATES_V1 = [
    { name: 'triage', initial: true },
    { name: 'done', terminal: true },
  ];
  const TRANSITIONS_V1 = [{ name: 'finish', from: ['triage'], to: 'done' }];

  const createWorkflow = async (body: Record<string, unknown> = {}) => {
    workflowSeq += 1;
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: `wfver-${workflowSeq}`,
        states: STATES_V1,
        transitions: TRANSITIONS_V1,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const patchWorkflow = async (
    id: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const res = await authenticatedTestClient(userToken)
      .patch(`/api/v1/workflows/${id}`)
      .send(body);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'wflver',
      policyActions: WORKFLOW_VERSION_ACTIONS,
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;
  });

  describe('archiving', () => {
    test('creating a workflow archives version 1', async () => {
      const workflow = await createWorkflow({ version_label: 'initial' });
      expect(workflow.version).toBe(1);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/1`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^wfl_ver_/);
      expect(res.body.workflow_id).toBe(workflow.id);
      expect(res.body.version).toBe(1);
      expect(res.body.config.states).toEqual(STATES_V1);
      expect(res.body.config.transitions).toEqual(TRANSITIONS_V1);
      expect(res.body.label).toBe('initial');
      expect(res.body.created_by).toBe(userId);
      expect(res.body.created_at).toBeDefined();
    });

    test('the archived config carries the definition and nothing else', async () => {
      const workflow = await createWorkflow({
        description: 'metadata that is not versioned',
        payload_schema: { type: 'object' },
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/1`
      );

      // Pinned deliberately. Only the state machine is versioned: bumping the
      // version when a name or description changes would make two version
      // numbers denote the same machine, and the version number is exactly what
      // a task cites to say which machine it is living in.
      expect(Object.keys(res.body.config).sort()).toEqual([
        'payload_schema',
        'states',
        'transitions',
      ]);
    });

    test('a definition change bumps the version and archives the new definition', async () => {
      const workflow = await createWorkflow();

      const nextStates = [...STATES_V1, { name: 'blocked' }];
      const updated = await patchWorkflow(workflow.id, {
        states: nextStates,
        version_label: 'rewired',
      });
      expect(updated.version).toBe(2);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/2`
      );
      expect(res.status).toBe(200);
      expect(res.body.config.states).toEqual(nextStates);
      expect(res.body.label).toBe('rewired');

      // v1 is untouched by the edit.
      const v1 = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/1`
      );
      expect(v1.body.config.states).toEqual(STATES_V1);
    });

    test('a payload_schema change bumps the version', async () => {
      const workflow = await createWorkflow();

      const updated = await patchWorkflow(workflow.id, {
        payload_schema: { type: 'object', required: ['ticket'] },
      });
      expect(updated.version).toBe(2);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/2`
      );
      expect(res.body.config.payload_schema).toEqual({
        type: 'object',
        required: ['ticket'],
      });
    });

    test('a metadata-only edit archives no version', async () => {
      const workflow = await createWorkflow();

      const updated = await patchWorkflow(workflow.id, {
        description: 'renamed only',
      });
      expect(updated.version).toBe(1);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions`
      );
      expect(res.body.total).toBe(1);
    });

    test('re-writing the definition the workflow already holds archives no version', async () => {
      const workflow = await createWorkflow();

      const updated = await patchWorkflow(workflow.id, {
        states: STATES_V1,
        transitions: TRANSITIONS_V1,
      });
      expect(updated.version).toBe(1);
    });

    test('a JSON Logic guard round-trips through the archive verbatim', async () => {
      const guard = { '==': [{ var: 'task.payload.max_daily_budget' }, 10] };
      const transitions = [
        { name: 'finish', from: ['triage'], to: 'done', guard },
      ];
      const workflow = await createWorkflow({ transitions });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/1`
      );
      // The underscore path inside the JSON Logic `var` must survive the archive
      // untouched — it is an author-owned value, not a field name.
      expect(res.body.config.transitions).toEqual(transitions);
    });
  });

  describe('GET /api/v1/workflows/:workflow_id/versions', () => {
    let workflowId: string;

    beforeAll(async () => {
      const workflow = await createWorkflow();
      workflowId = workflow.id;
      await patchWorkflow(workflowId, {
        states: [...STATES_V1, { name: 'blocked' }],
      });
      await patchWorkflow(workflowId, {
        states: [...STATES_V1, { name: 'blocked' }, { name: 'parked' }],
      });
    });

    test('lists versions newest first', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflowId}/versions`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(
        res.body.data.map((v: { version: number }) => {
          return v.version;
        })
      ).toEqual([3, 2, 1]);
      expect(res.body.data[0].workflow_id).toBe(workflowId);
    });

    test('honors limit and offset', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflowId}/versions?limit=1&offset=1`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].version).toBe(2);
      expect(res.body.total).toBe(3);
    });

    test('unknown workflow returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/workflows/wfl_missing/versions'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    test('a workflow in another project is refused', async () => {
      const other = await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: otherProjectId,
          name: 'other-project-workflow',
          states: STATES_V1,
          transitions: TRANSITIONS_V1,
        });
      expect(other.status).toBe(201);

      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/workflows/${other.body.id}/versions`
      );
      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/workflows/${workflowId}/versions`
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/workflows/:workflow_id/versions/:version', () => {
    test('unknown version returns 404', async () => {
      const workflow = await createWorkflow();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/99`
      );
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/has no version 99/);
    });

    test('non-integer version returns 400', async () => {
      const workflow = await createWorkflow();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/latest`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/workflows/:workflow_id/versions/:version/restore', () => {
    test('restore appends a new version rather than rewinding the counter', async () => {
      const workflow = await createWorkflow();
      await patchWorkflow(workflow.id, {
        states: [...STATES_V1, { name: 'blocked' }],
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/workflows/${workflow.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(3);
      expect(res.body.states).toEqual(STATES_V1);

      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/3`
      );
      expect(v3.body.config.states).toEqual(STATES_V1);
      expect(v3.body.label).toBe('restored from v1');

      // v2 is still readable, so a task pinned to it still resolves its machine.
      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/2`
      );
      expect(v2.status).toBe(200);
    });

    test('an explicit label annotates the version the restore creates', async () => {
      const workflow = await createWorkflow();
      await patchWorkflow(workflow.id, {
        states: [...STATES_V1, { name: 'blocked' }],
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/workflows/${workflow.id}/versions/1/restore`)
        .send({ label: 'rollback to pre-rewire' });

      expect(res.status).toBe(200);
      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions/3`
      );
      expect(v3.body.label).toBe('rollback to pre-rewire');
    });

    test('restoring the live definition is a no-op that creates no version', async () => {
      const workflow = await createWorkflow();

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/workflows/${workflow.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('restore leaves metadata untouched — only the definition rolls back', async () => {
      const workflow = await createWorkflow({ description: 'original' });
      await patchWorkflow(workflow.id, {
        description: 'current description',
        states: [...STATES_V1, { name: 'blocked' }],
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/workflows/${workflow.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.description).toBe('current description');
      expect(res.body.states).toEqual(STATES_V1);
    });

    test('a restored definition whose dispatch target is gone is refused', async () => {
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Workflow Versions Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      expect(provider.status).toBe(201);

      const agent = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'doomed-dispatch-agent',
          ai_provider_id: provider.body.id,
        });
      expect(agent.status).toBe(201);

      const workflow = await createWorkflow({
        states: [
          {
            name: 'triage',
            initial: true,
            on_enter: {
              dispatch: { kind: 'agent', agent_id: agent.body.id },
              on_complete: [{ when: true, transition: 'finish' }],
            },
          },
          { name: 'done', terminal: true },
        ],
      });
      await patchWorkflow(workflow.id, { states: STATES_V1 });

      const deleted = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agent.body.id}`
      );
      expect(deleted.status).toBe(204);

      // Unlike an orchestration graph — whose node references resolve when a run
      // reaches the node — a workflow's dispatch targets are resolved at write
      // time, so a stale one fails the restore instead of stranding a task on
      // entry.
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/workflows/${workflow.id}/versions/1/restore`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    });

    test('unknown version returns 404', async () => {
      const workflow = await createWorkflow();
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/workflows/${workflow.id}/versions/42/restore`
      );
      expect(res.status).toBe(404);
    });

    test('non-integer version returns 400', async () => {
      const workflow = await createWorkflow();
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/workflows/${workflow.id}/versions/one/restore`
      );
      expect(res.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const workflow = await createWorkflow();
      const res = await testClient.post(
        `/api/v1/workflows/${workflow.id}/versions/1/restore`
      );
      expect(res.status).toBe(401);
    });
  });

  describe('deletion', () => {
    test('deleting a workflow removes its archived versions', async () => {
      const workflow = await createWorkflow();
      await patchWorkflow(workflow.id, {
        states: [...STATES_V1, { name: 'blocked' }],
      });

      const del = await authenticatedTestClient(userToken).delete(
        `/api/v1/workflows/${workflow.id}`
      );
      expect(del.status).toBe(204);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${workflow.id}/versions`
      );
      expect(versions.status).toBe(404);
    });
  });

  describe('a restricted API key', () => {
    /**
     * A project-scoped API key whose policy excludes `excludedAction`, so the
     * request reaches the route with a resolvable project and exercises the 403
     * branch rather than the not-found one.
     */
    const createRestrictedApiKey = async (excludedAction: string) => {
      const allowedActions = WORKFLOW_VERSION_ACTIONS.filter((action) => {
        return action !== excludedAction;
      });
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: allowedActions }],
          },
        });
      expect(policyRes.status).toBe(201);

      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          project_id: projectId,
          name: `No ${excludedAction} Key`,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      return keyRes.body.key as string;
    };

    test('without ListWorkflowVersions returns 403', async () => {
      const workflow = await createWorkflow();
      const rawKey = await createRestrictedApiKey(
        'workflows:ListWorkflowVersions'
      );
      const res = await authenticatedTestClient(rawKey).get(
        `/api/v1/workflows/${workflow.id}/versions`
      );
      expect(res.status).toBe(403);
    });

    test('without GetWorkflowVersion returns 403', async () => {
      const workflow = await createWorkflow();
      const rawKey = await createRestrictedApiKey(
        'workflows:GetWorkflowVersion'
      );
      const res = await authenticatedTestClient(rawKey).get(
        `/api/v1/workflows/${workflow.id}/versions/1`
      );
      expect(res.status).toBe(403);
    });

    test('without RestoreWorkflowVersion returns 403', async () => {
      const workflow = await createWorkflow();
      const rawKey = await createRestrictedApiKey(
        'workflows:RestoreWorkflowVersion'
      );
      const res = await authenticatedTestClient(rawKey).post(
        `/api/v1/workflows/${workflow.id}/versions/1/restore`
      );
      expect(res.status).toBe(403);
    });
  });
});
