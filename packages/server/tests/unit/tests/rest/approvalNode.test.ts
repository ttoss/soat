import { db } from 'src/db';
import { expireDueApprovals } from 'src/lib/approvalScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// End-to-end coverage of the `approval` orchestration node (producer #1): a run
// parks on the node, the platform files an ApprovalItem, and resolving it
// (approve / reject / expire) resumes the run and routes it down the matching
// decision edge. Exercised through the real REST entry points — starting a run
// and resolving via /approvals — with the run's own resume machinery.

describe('Approval node (orchestration producer)', () => {
  let userToken: string;
  let projectId: string;

  // gate → done  (on approved)
  // gate → nope  (on rejected)
  // gate → stale (on expired)
  const approvalOrchestration = {
    name: 'Approval Gate Pipeline',
    nodes: [
      {
        id: 'gate',
        type: 'approval',
        tool_id: 'tool_issuerefund0001',
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

  let orchestrationId: string;

  const startRun = async (): Promise<{ runId: string; approvalId: string }> => {
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
      runId: runRes.body.id,
      approvalId: runRes.body.required_action.approval_id,
    };
  };

  const getRun = async (runId: string) => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${runId}`
    );
    expect(res.status).toBe(200);
    return res.body;
  };

  // The expiry sweeper dispatches its handler (which resumes the run) detached,
  // so poll the observable side effect — the run reaching a terminal state — with
  // a bounded loop rather than reading once and racing the resume (which
  // transitions through a transient `running` state before it settles).
  const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
  const waitForRunSettled = async (runId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const run = await getRun(runId);
      if (TERMINAL.includes(run.status)) return run;
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    }
    throw new Error(`run ${runId} did not settle`);
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

    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({ ...approvalOrchestration, project_id: projectId });
    expect(createRes.status).toBe(201);
    orchestrationId = createRes.body.id;
  });

  test('starting a run parks on the node and files an approval item', async () => {
    const { runId, approvalId } = await startRun();
    expect(approvalId).toMatch(/^apr_/);

    const listRes = await authenticatedTestClient(userToken).get(
      `/api/v1/approvals?project_id=${projectId}&status=pending`
    );
    expect(listRes.status).toBe(200);
    const item = listRes.body.find((a: { id: string }) => {
      return a.id === approvalId;
    });
    expect(item).toBeDefined();
    expect(item.origin).toBe('node');
    expect(item.run_id).toBe(runId);
    expect(item.node_id).toBe('gate');
    expect(item.proposed_action.tool_id).toBe('tool_issuerefund0001');
    expect(item.proposed_action.arguments).toEqual({ amount: 500 });
    expect(item.reasoning).toBe('Refund exceeds the auto-approve threshold.');
  });

  test('approving resumes the run down the approved edge', async () => {
    const { runId, approvalId } = await startRun();

    const approveRes = await authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');

    const run = await getRun(runId);
    expect(run.status).toBe('succeeded');
    expect(run.state.result).toBe('approved!');
  });

  test('rejecting resumes the run down the rejected edge', async () => {
    const { runId, approvalId } = await startRun();

    const rejectRes = await authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${approvalId}/reject`)
      .send({ reason: 'Over budget' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('rejected');

    const run = await getRun(runId);
    expect(run.status).toBe('succeeded');
    expect(run.state.result).toBe('rejected!');
  });

  test('expiry resumes the run down the on_expired edge', async () => {
    const { runId, approvalId } = await startRun();

    // Force the item past its expiry, then run the sweeper as the scheduler
    // would. The sweep flips it to expired and resumes the parked run.
    await db.ApprovalItem.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { publicId: approvalId } }
    );
    const claimed = await expireDueApprovals();
    expect(claimed).toBeGreaterThanOrEqual(1);

    const run = await waitForRunSettled(runId);
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
});
