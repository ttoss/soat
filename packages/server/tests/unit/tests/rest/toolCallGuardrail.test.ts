import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A tool-scoped guardrail "governs that tool wherever it is used" — that is the
 * contract the guardrails page states, and the reason attaching one to a
 * dangerous tool is meant to be enough. Only the agent dispatch and the
 * orchestration `tool` node honoured it: a direct call and a pipeline step
 * reached `callTool` with nothing consulting the tool's `guardrail_ids`, so
 * either one walked past a class-D block.
 */
describe('a tool-scoped guardrail governs every way the tool is called', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let blockedToolId: string;
  let openToolId: string;
  let pipelineOverBlockedId: string;

  const createBuiltinTool = async (args: {
    name: string;
    guardrailIds?: string[];
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: args.name,
        type: 'builtin',
        actions: ['list-tools'],
        ...(args.guardrailIds ? { guardrail_ids: args.guardrailIds } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'tcguard',
      policyActions: [
        'guardrails:CreateGuardrail',
        'tools:CreateTool',
        'tools:GetTool',
        'tools:ListTools',
        'tools:CallTool',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const blockingGuardrail = await authenticatedTestClient(adminToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: 'tcguard-forbid',
        document: { class: 'D' },
      });
    expect(blockingGuardrail.status).toBe(201);

    blockedToolId = await createBuiltinTool({
      name: 'tcguard-blocked',
      guardrailIds: [blockingGuardrail.body.id],
    });
    openToolId = await createBuiltinTool({ name: 'tcguard-open' });

    const pipelineRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'tcguard-pipeline',
        type: 'pipeline',
        pipeline: {
          steps: [
            {
              id: 'step1',
              tool_id: blockedToolId,
              action: 'list-tools',
              input: {},
            },
          ],
        },
      });
    expect(pipelineRes.status).toBe(201);
    pipelineOverBlockedId = pipelineRes.body.id;
  });

  test('a direct call of a class-D tool is refused', async () => {
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${blockedToolId}/call`)
      .send({ action: 'list-tools', input: {} });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOOL_DISPATCH_FAILED');
    expect(res.body.error.meta.outcome).toBe('blocked');
  });

  // The pipeline runner wraps a failing step, so the refusal arrives naming
  // which step the guardrail settled rather than as a bare tool failure.
  test('a pipeline step reaching that tool is refused too', async () => {
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${pipelineOverBlockedId}/call`)
      .send({ input: {} });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PIPELINE_STEP_FAILED');
    expect(res.body.error.meta.step_id).toBe('step1');
    expect(res.body.error.message).toContain("settled as 'blocked'");
  });

  test('a tool nothing gates still calls straight through', async () => {
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${openToolId}/call`)
      .send({ action: 'list-tools', input: {} });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // A direct call has no turn to return a pending result into and no run to
  // park, so sign-off cannot be awaited — it is refused rather than executed.
  test('a class-C tool is refused rather than executed', async () => {
    const approvalGuardrail = await authenticatedTestClient(adminToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: 'tcguard-signoff',
        document: { class: 'C' },
      });
    const signOffToolId = await createBuiltinTool({
      name: 'tcguard-signoff-tool',
      guardrailIds: [approvalGuardrail.body.id],
    });

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${signOffToolId}/call`)
      .send({ action: 'list-tools', input: {} });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOOL_DISPATCH_FAILED');
    expect(res.body.error.meta.outcome).toBe('route_to_approval');
  });
});
