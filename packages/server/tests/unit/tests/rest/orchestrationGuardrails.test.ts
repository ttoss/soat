import * as toolsModule from 'src/lib/tools';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// Guardrail interception on the orchestration `tool` node dispatch path (G4).
// The interceptor was previously wired only into agent tool-dispatch; a tool
// node executed `callTool` directly with no classification. These tests drive
// the gate through the run entry point: a class-D guardrail must block the
// call (routable `blocked` outcome, edges can branch on it) without ever
// reaching the tool, and a passing/absent guardrail must let it execute.

describe('Orchestration tool-node guardrails', () => {
  let userToken: string;
  let projectId: string;

  const createGuardrail = async (args: {
    name: string;
    document: Record<string, unknown>;
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: args.name,
        document: args.document,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createTool = async (args: {
    name: string;
    guardrailIds?: string[];
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: args.name,
        type: 'client',
        ...(args.guardrailIds ? { guardrail_ids: args.guardrailIds } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const startRun = async (orchestrationId: string) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestrationId, input: {} });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'orchguard',
      policyActions: [
        'guardrails:CreateGuardrail',
        'guardrails:GetGuardrail',
        'tools:CreateTool',
        'tools:GetTool',
        'orchestrations:CreateOrchestration',
        'orchestrations:GetOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'orchestrations:ListRuns',
        'approvals:ListApprovals',
        'approvals:GetApproval',
        'approvals:ResolveApproval',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a class-D guardrail blocks the tool call before it dispatches', async () => {
    const guardrailId = await createGuardrail({
      name: 'Block All',
      document: { class: 'D' },
    });
    const toolId = await createTool({
      name: 'Blocked Tool',
      guardrailIds: [guardrailId],
    });

    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        name: 'Blocked Tool Pipeline',
        project_id: projectId,
        nodes: [
          { id: 'act', type: 'tool', tool_id: toolId, input_mapping: {} },
          {
            id: 'fallback',
            type: 'transform',
            expression: 'handled',
            state_mapping: { 'state.branch': { var: 'output.result' } },
          },
        ],
        // The blocked outcome is routable: an edge conditioned on `blocked`
        // follows when the guardrail blocks the call.
        edges: [{ from: 'act', to: 'fallback', condition: 'blocked' }],
      });
    expect(createRes.status).toBe(201);

    const callToolSpy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ ok: true });

    const runRes = await startRun(createRes.body.id);

    expect(runRes.status).toBe(201);
    // The guardrail short-circuits dispatch: the tool is never called.
    expect(callToolSpy).not.toHaveBeenCalled();
    expect(runRes.body.status).toBe('succeeded');

    const getRes = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${runRes.body.id}`
    );
    const byId = new Map<string, { status: string }>(
      getRes.body.node_executions.map(
        (n: { node_id: string; status: string }) => {
          return [n.node_id, n];
        }
      )
    );
    // The blocked branch routed to the fallback node, which ran.
    expect(byId.get('fallback')?.status).toBe('completed');
  });

  test('an unlabeled successor does not auto-follow a blocked tool node', async () => {
    const guardrailId = await createGuardrail({
      name: 'Block All 2',
      document: { class: 'D' },
    });
    const toolId = await createTool({
      name: 'Blocked Tool 2',
      guardrailIds: [guardrailId],
    });

    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        name: 'Blocked No Branch Pipeline',
        project_id: projectId,
        nodes: [
          { id: 'act', type: 'tool', tool_id: toolId, input_mapping: {} },
          { id: 'after', type: 'transform', expression: 'ran' },
        ],
        // No `condition` on the edge — the happy path must NOT run after a block.
        edges: [{ from: 'act', to: 'after' }],
      });
    expect(createRes.status).toBe(201);

    const callToolSpy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ ok: true });

    const runRes = await startRun(createRes.body.id);
    expect(runRes.status).toBe(201);
    expect(callToolSpy).not.toHaveBeenCalled();

    const getRes = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${runRes.body.id}`
    );
    const after = getRes.body.node_executions.find((n: { node_id: string }) => {
      return n.node_id === 'after';
    });
    // The happy-path successor is skipped, never executed, after a block.
    expect(after?.status).toBe('skipped');
  });

  test('a tool node with no guardrails executes normally', async () => {
    const toolId = await createTool({ name: 'Open Tool' });

    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        name: 'Open Tool Pipeline',
        project_id: projectId,
        nodes: [
          {
            id: 'act',
            type: 'tool',
            tool_id: toolId,
            input_mapping: {},
            state_mapping: { 'state.done': { var: 'output.ok' } },
          },
        ],
        edges: [],
      });
    expect(createRes.status).toBe(201);

    const callToolSpy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ ok: 'yes' });

    const runRes = await startRun(createRes.body.id);
    expect(runRes.status).toBe(201);
    expect(runRes.body.status).toBe('succeeded');
    expect(callToolSpy).toHaveBeenCalledTimes(1);
  });

  test('a class-A guardrail lets the tool execute', async () => {
    const guardrailId = await createGuardrail({
      name: 'Allow All',
      document: { class: 'A' },
    });
    const toolId = await createTool({
      name: 'Allowed Tool',
      guardrailIds: [guardrailId],
    });

    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        name: 'Allowed Tool Pipeline',
        project_id: projectId,
        nodes: [
          { id: 'act', type: 'tool', tool_id: toolId, input_mapping: {} },
        ],
        edges: [],
      });
    expect(createRes.status).toBe(201);

    const callToolSpy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ ok: true });

    const runRes = await startRun(createRes.body.id);
    expect(runRes.status).toBe(201);
    expect(runRes.body.status).toBe('succeeded');
    expect(callToolSpy).toHaveBeenCalledTimes(1);
  });

  // ── Class C: route to approval, park the run, execute on approval ──────────
  describe('class-C approval routing', () => {
    const buildApprovalPipeline = async (): Promise<string> => {
      const guardrailId = await createGuardrail({
        name: 'Needs Approval',
        document: { class: 'C' },
      });
      const toolId = await createTool({
        name: 'Approvable Tool',
        guardrailIds: [guardrailId],
      });
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Approval Tool Pipeline',
          project_id: projectId,
          nodes: [
            {
              id: 'act',
              type: 'tool',
              tool_id: toolId,
              input_mapping: { amount: { var: 'input.amount' } },
              state_mapping: { 'state.acted': { var: 'output.ok' } },
            },
            {
              id: 'done',
              type: 'transform',
              expression: 'continued',
              state_mapping: { 'state.after': { var: 'output.result' } },
            },
          ],
          edges: [{ from: 'act', to: 'done' }],
        });
      expect(createRes.status).toBe(201);
      return createRes.body.id;
    };

    const startApprovalRun = async (orchestrationId: string) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: orchestrationId,
          input: { amount: 500 },
        });
    };

    test('a class-C guardrail parks the run and files an approval item', async () => {
      const orchestrationId = await buildApprovalPipeline();
      const callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ ok: 'yes' });

      const runRes = await startApprovalRun(orchestrationId);

      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');
      expect(runRes.body.required_action.type).toBe('approval');
      expect(runRes.body.required_action.node_id).toBe('act');
      expect(runRes.body.required_action.approval_id).toMatch(/^apr_/);
      // The tool has not run — it is held pending approval.
      expect(callToolSpy).not.toHaveBeenCalled();

      // The frozen proposal carries the resolved tool arguments.
      const item = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals/${runRes.body.required_action.approval_id}`
      );
      expect(item.body.proposed_action.arguments).toEqual({ amount: 500 });
    });

    test('approving executes the tool with the frozen args and continues', async () => {
      const orchestrationId = await buildApprovalPipeline();
      const callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ ok: 'yes' });

      const runRes = await startApprovalRun(orchestrationId);
      const approvalId = runRes.body.required_action.approval_id;

      const approveRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approvalId}/approve`)
        .send({});
      expect(approveRes.status).toBe(200);

      // On approval the tool executes exactly once, with the frozen args, and
      // the run continues down the (unlabeled) success edge.
      expect(callToolSpy).toHaveBeenCalledTimes(1);
      expect(callToolSpy.mock.calls[0]?.[0]).toMatchObject({
        input: { amount: 500 },
      });

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runRes.body.id}`
      );
      expect(getRes.body.status).toBe('succeeded');
      expect(getRes.body.state.after).toBe('continued');
    });

    test("a guardrail's expires_in sets the approval window (not the 24h default)", async () => {
      const EXPIRES_IN = 259200; // 72h — deliberately not the 24h default
      const guardrailId = await createGuardrail({
        name: 'Approval With Window',
        document: { class: 'C', expires_in: EXPIRES_IN },
      });
      const toolId = await createTool({
        name: 'Windowed Tool',
        guardrailIds: [guardrailId],
      });
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Windowed Approval Pipeline',
          project_id: projectId,
          nodes: [
            { id: 'act', type: 'tool', tool_id: toolId, input_mapping: {} },
          ],
          edges: [],
        });
      expect(createRes.status).toBe(201);

      jest.spyOn(toolsModule, 'callTool').mockResolvedValue({ ok: 'yes' });

      const runRes = await startApprovalRun(createRes.body.id);
      const approvalId = runRes.body.required_action.approval_id;

      const item = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals/${approvalId}`
      );
      const windowSeconds =
        (new Date(item.body.expires_at).getTime() -
          new Date(item.body.created_at).getTime()) /
        1000;
      // The governing guardrail's expires_in wins over the 24h default.
      expect(Math.abs(windowSeconds - EXPIRES_IN)).toBeLessThan(120);
    });

    test('rejecting does not execute the tool', async () => {
      const orchestrationId = await buildApprovalPipeline();
      const callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ ok: 'yes' });

      const runRes = await startApprovalRun(orchestrationId);
      const approvalId = runRes.body.required_action.approval_id;

      const rejectRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approvalId}/reject`)
        .send({ reason: 'Not allowed' });
      expect(rejectRes.status).toBe(200);

      // A rejected call never executes, and the happy-path successor does not run.
      expect(callToolSpy).not.toHaveBeenCalled();
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runRes.body.id}`
      );
      const done = getRes.body.node_executions.find(
        (n: { node_id: string }) => {
          return n.node_id === 'done';
        }
      );
      expect(done?.status).not.toBe('completed');
    });
  });
});
