import { db } from 'src/db';
import { expireDueApprovals } from 'src/lib/approvalScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// A run parks on the node, the platform files an ApprovalItem, and resolving it
// resumes the run down the matching decision edge — driven through the real REST
// entry points.

describe('Approval node (orchestration producer)', () => {
  let userToken: string;
  let projectId: string;

  // gate → done  (on approved)
  // gate → nope  (on rejected)
  // gate → stale (on expired)
  const approvalOrchestration = (toolId: string) => {
    return {
      name: 'Approval Gate Pipeline',
      nodes: [
        {
          id: 'gate',
          type: 'approval',
          tool_id: toolId,
          arguments: { amount: { var: 'input.amount' } },
          reasoning: 'Refund exceeds the auto-approve threshold.',
          expires_in: 3600,
        },
        {
          id: 'done',
          type: 'transform',
          expression: 'approved!',
          state_mapping: { 'state.result': { var: 'output.result' } },
        },
        {
          id: 'nope',
          type: 'transform',
          expression: 'rejected!',
          state_mapping: { 'state.result': { var: 'output.result' } },
        },
        {
          id: 'stale',
          type: 'transform',
          expression: 'expired!',
          state_mapping: { 'state.result': { var: 'output.result' } },
        },
      ],
      edges: [
        { from: 'gate', to: 'done', condition: 'approved' },
        { from: 'gate', to: 'nope', condition: 'rejected' },
        { from: 'gate', to: 'stale', condition: 'expired' },
      ],
    };
  };

  let orchestrationId: string;
  let refundToolId: string;

  const startRun = async (): Promise<{
    orchestrationRunId: string;
    approvalId: string;
  }> => {
    const runRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({
        wait: true,
        orchestration_id: orchestrationId,
        input: { amount: 500 },
      });
    expect(runRes.status).toBe(201);
    expect(runRes.body.status).toBe('awaiting_input');
    expect(runRes.body.required_action.type).toBe('approval');
    expect(runRes.body.required_action.node_id).toBe('gate');
    return {
      orchestrationRunId: runRes.body.id,
      approvalId: runRes.body.required_action.approval_id,
    };
  };

  const getRun = async (orchestrationRunId: string) => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${orchestrationRunId}`
    );
    expect(res.status).toBe(200);
    return res.body;
  };

  // The expiry sweeper dispatches its handler (which resumes the run) detached,
  // so poll the observable side effect — the run reaching a terminal state — with
  // a bounded loop rather than reading once and racing the resume (which
  // transitions through a transient `running` state before it settles).
  const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
  const waitForRunSettled = async (orchestrationRunId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const run = await getRun(orchestrationRunId);
      if (TERMINAL.includes(run.status)) return run;
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    }
    throw new Error(`run ${orchestrationRunId} did not settle`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aprnode',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'approvals:ListApprovals',
        'approvals:GetApproval',
        'approvals:ResolveApproval',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    // The node proposes this tool; nothing calls it until the item is settled.
    const toolRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'issueRefund',
        type: 'http',
        execute: { url: 'https://example.com/refunds', method: 'POST' },
      });
    refundToolId = toolRes.body.id;
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        ...approvalOrchestration(refundToolId),
        project_id: projectId,
      });
    expect(createRes.status).toBe(201);
    orchestrationId = createRes.body.id;
  });

  test('starting a run parks on the node and files an approval item', async () => {
    const { orchestrationRunId, approvalId } = await startRun();
    expect(approvalId).toMatch(/^apr_/);

    const listRes = await authenticatedTestClient(userToken).get(
      `/api/v1/approvals?project_id=${projectId}&status=pending`
    );
    expect(listRes.status).toBe(200);
    const item = listRes.body.data.find((a: { id: string }) => {
      return a.id === approvalId;
    });
    expect(item).toBeDefined();
    expect(item.origin).toBe('node');
    expect(item.orchestration_run_id).toBe(orchestrationRunId);
    expect(item.node_id).toBe('gate');
    expect(item.proposed_action.tool_id).toBe(refundToolId);
    expect(item.proposed_action.arguments).toEqual({ amount: 500 });
    expect(item.reasoning).toBe('Refund exceeds the auto-approve threshold.');
  });

  test('approving resumes the run down the approved edge', async () => {
    const { orchestrationRunId, approvalId } = await startRun();

    const approveRes = await authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');

    const run = await getRun(orchestrationRunId);
    expect(run.status).toBe('succeeded');
    expect(run.state.result).toBe('approved!');
  });

  test('rejecting resumes the run down the rejected edge', async () => {
    const { orchestrationRunId, approvalId } = await startRun();

    const rejectRes = await authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${approvalId}/reject`)
      .send({ reason: 'Over budget' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('rejected');

    const run = await getRun(orchestrationRunId);
    expect(run.status).toBe('succeeded');
    expect(run.state.result).toBe('rejected!');
  });

  test('expiry resumes the run down the on_expired edge', async () => {
    const { orchestrationRunId, approvalId } = await startRun();

    // Force the item past its expiry, then run the sweeper as the scheduler
    // would. The sweep flips it to expired and resumes the parked run.
    await db.ApprovalItem.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { publicId: approvalId } }
    );
    const claimed = await expireDueApprovals();
    expect(claimed).toBeGreaterThanOrEqual(1);

    const run = await waitForRunSettled(orchestrationRunId);
    expect(run.status).toBe('succeeded');
    expect(run.state.result).toBe('expired!');
  });

  test('an approved run cannot be resolved twice', async () => {
    const { approvalId } = await startRun();
    await authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .send({});
    const secondRes = await authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .send({});
    expect(secondRes.status).toBe(409);
    expect(secondRes.body.error.code).toBe('APPROVAL_ALREADY_RESOLVED');
  });

  // The node resolves every mapping against run state and freezes the result
  // onto the filed item, so what a reviewer reads is what the run computed.
  describe('the proposal the node freezes', () => {
    const DAY_SECONDS = 24 * 60 * 60;

    const parkOn = async (gate: Record<string, unknown>) => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: `Approval Proposal ${Math.random()}`,
          nodes: [
            { id: 'gate', type: 'approval', tool_id: refundToolId, ...gate },
          ],
          edges: [],
        });
      expect(createRes.status).toBe(201);
      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { amt: 500 },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');
      const itemRes = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals/${runRes.body.required_action.approval_id}`
      );
      expect(itemRes.status).toBe(200);
      return { run: runRes.body, item: itemRes.body };
    };

    const windowSeconds = (item: {
      created_at: string;
      expires_at: string;
    }) => {
      return Math.round(
        (new Date(item.expires_at).getTime() -
          new Date(item.created_at).getTime()) /
          1000
      );
    };

    test('every mapping resolves into the filed item', async () => {
      const { run, item } = await parkOn({
        arguments: { amount: { var: 'input.amt' } },
        reasoning: 'needs review',
        evidence: { order_id: 'ord_1' },
        predicted_impact: 'issues a refund',
        expires_in: 60,
        instructions: 'Please review',
      });

      expect(run.required_action.prompt).toBe('Please review');
      expect(item.proposed_action.arguments).toEqual({ amount: 500 });
      expect(item.reasoning).toBe('needs review');
      expect(item.evidence).toEqual({ order_id: 'ord_1' });
      expect(item.predicted_impact).toBe('issues a refund');
      expect(windowSeconds(item)).toBe(60);
    });

    test('a null reasoning and a non-object evidence file as null, an impact is stringified, and the window defaults to a day', async () => {
      const { run, item } = await parkOn({
        reasoning: { var: 'input.missing' },
        evidence: 'not-an-object',
        predicted_impact: 42,
        expires_in: 0,
      });

      expect(run.required_action.prompt).toBe('Approval required.');
      expect(item.proposed_action.arguments).toEqual({});
      expect(item.reasoning).toBeNull();
      expect(item.evidence).toBeNull();
      expect(item.predicted_impact).toBe('42');
      expect(windowSeconds(item)).toBe(DAY_SECONDS);
    });

    test('a node naming no reasoning, evidence or impact files all three as null', async () => {
      const { item } = await parkOn({});

      expect(item.reasoning).toBeNull();
      expect(item.evidence).toBeNull();
      expect(item.predicted_impact).toBeNull();
    });
  });
});
