import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * A run's verdict (the evaluations module doc — Pass semantics, Evidence): read
 * on the pass rate's 95% interval against the threshold, so the sample size is
 * part of the answer, and on every group `evidence.required_groups` names.
 */

type Message = { role: string; content: string };

type VerdictReason = {
  scope: { kind: string; name?: string };
  verdict: string;
  reason: string;
};

type RunBody = {
  id: string;
  status: string;
  verdict: string | null;
  verdict_reasons: VerdictReason[] | null;
};

describe('Evaluations — verdict', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let agentId: string;
  let twentyId: string;
  let thirtyFiveId: string;
  let erroringId: string;
  let seq = 0;

  // The stubbed agent answers `nope` for an item in this set and `ok`
  // otherwise; an item whose input starts with ERROR fails its generation.
  let failing = new Set<string>();

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const items = (count: number, prefix: string): string[] => {
    return Array.from({ length: count }, (_, index) => {
      return `${prefix}-${index + 1}`;
    });
  };

  const createDataset = async (args: {
    contents: string[];
    kindOf?: (index: number) => string;
  }): Promise<string> => {
    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: unique('verdict-dataset') });
    expect(dataset.status).toBe(201);
    for (const [index, content] of args.contents.entries()) {
      const item = await asUser()
        .post(`/api/v1/datasets/${dataset.body.id}/items`)
        .send({
          input: [{ role: 'user', content }],
          ...(args.kindOf ? { metadata: { kind: args.kindOf(index) } } : {}),
        });
      expect(item.status).toBe(201);
    }
    return dataset.body.id as string;
  };

  const createEval = (args: {
    datasetId: string;
    body?: Record<string, unknown>;
  }) => {
    return asUser()
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('verdict-eval'),
        agent_id: agentId,
        dataset_id: args.datasetId,
        scorers: [{ type: 'contains', value: 'ok' }],
        ...args.body,
      });
  };

  const evalOf = async (args: {
    datasetId: string;
    body?: Record<string, unknown>;
  }): Promise<string> => {
    const res = await createEval(args);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const runSync = async (args: {
    evalId: string;
    failingItems?: string[];
  }): Promise<RunBody> => {
    failing = new Set(args.failingItems ?? []);
    const res = await asUser()
      .post(`/api/v1/evals/${args.evalId}/runs`)
      .send({ wait: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    return res.body as RunBody;
  };

  const reasonFor = (
    run: RunBody,
    scope: { kind: string; name?: string }
  ): VerdictReason | undefined => {
    return run.verdict_reasons?.find((reason) => {
      return (
        reason.scope.kind === scope.kind && reason.scope.name === scope.name
      );
    });
  };

  const twenty = items(20, 'twenty');

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    mockCreateGeneration.mockImplementation(async (args) => {
      const content = (args.messages as Message[])[0]!.content;
      if (content.startsWith('ERROR')) throw new Error('provider exploded');
      return {
        id: `gen_${content}`,
        traceId: `trc_${content}`,
        status: 'completed' as const,
        output: {
          model: 'test-model',
          content: failing.has(content) ? 'nope' : 'ok',
          finishReason: 'stop',
        },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'evalverdict',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:RunEval',
        'agents:CreateAgentGeneration',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Verdict Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'verdict-agent',
        instructions: 'Answer briefly.',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    // The first ten items are kind `x`, the last ten kind `y`.
    twentyId = await createDataset({
      contents: twenty,
      kindOf: (index) => {
        return index < 10 ? 'x' : 'y';
      },
    });
    thirtyFiveId = await createDataset({ contents: items(35, 'many') });
    erroringId = await createDataset({ contents: ['ERROR-1', 'ERROR-2'] });
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
  });

  describe('the interval against the threshold', () => {
    test('19 of 20 at 0.9 is insufficient: the interval holds the threshold', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: { pass_threshold: 0.9 },
      });

      const run = await runSync({ evalId, failingItems: ['twenty-20'] });

      expect(run.verdict).toBe('insufficient');
      expect(run.verdict_reasons).toEqual([
        {
          scope: { kind: 'run' },
          verdict: 'insufficient',
          reason: expect.stringContaining('0.9'),
        },
      ]);
    });

    test('5 of 20 at 0.9 is refuted: the whole interval is under the threshold', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: { pass_threshold: 0.9 },
      });

      const run = await runSync({ evalId, failingItems: twenty.slice(5) });

      expect(run.verdict).toBe('refuted');
    });

    test('35 of 35 at 0.9 is supported: the interval clears the threshold', async () => {
      const evalId = await evalOf({
        datasetId: thirtyFiveId,
        body: { pass_threshold: 0.9 },
      });
      failing = new Set();

      const start = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(start.status).toBe(201);
      expect(await drainEvalQueueOnce({ limit: 35 })).toBe(35);

      const run = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${start.body.id}`
      );
      expect(run.status).toBe(200);
      expect(run.body.verdict).toBe('supported');
    });

    test('a run that scored nothing is insufficient, never supported', async () => {
      const evalId = await evalOf({
        datasetId: erroringId,
        body: { pass_threshold: 0.5 },
      });

      const run = await runSync({ evalId });

      expect(run.verdict).toBe('insufficient');
      expect(reasonFor(run, { kind: 'run' })?.reason).toContain(
        'no scored items'
      );
    });

    test('an eval with no threshold reports without a verdict', async () => {
      const evalId = await evalOf({ datasetId: twentyId });

      const run = await runSync({ evalId });

      expect(run.verdict).toBeNull();
      expect(run.verdict_reasons).toBeNull();
    });

    test('the run carries no point verdict', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: { pass_threshold: 0.5 },
      });

      const run = await runSync({ evalId });

      expect(run.verdict).toBe('supported');
      expect(run).not.toHaveProperty('passed');
    });
  });

  describe('required groups', () => {
    test('a required group with no scored items is insufficient', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: {
          pass_threshold: 0.5,
          group_by: 'kind',
          evidence: { required_groups: ['x', 'z'] },
        },
      });

      const run = await runSync({ evalId });

      expect(run.verdict).toBe('insufficient');
      expect(reasonFor(run, { kind: 'run' })?.verdict).toBe('supported');
      expect(reasonFor(run, { kind: 'group', name: 'x' })?.verdict).toBe(
        'supported'
      );
      expect(reasonFor(run, { kind: 'group', name: 'z' })).toEqual({
        scope: { kind: 'group', name: 'z' },
        verdict: 'insufficient',
        reason: expect.stringContaining('no scored items'),
      });
    });

    test('a weak required group decides a run that is strong overall', async () => {
      // 15 of 20 clears 0.5 (low ≈ 0.53); y alone is 5 of 10 (≈ 0.24–0.76).
      const evalId = await evalOf({
        datasetId: twentyId,
        body: {
          pass_threshold: 0.5,
          group_by: 'kind',
          evidence: { required_groups: ['y'] },
        },
      });

      const run = await runSync({ evalId, failingItems: twenty.slice(15) });

      expect(reasonFor(run, { kind: 'run' })?.verdict).toBe('supported');
      expect(reasonFor(run, { kind: 'group', name: 'y' })?.verdict).toBe(
        'insufficient'
      );
      expect(run.verdict).toBe('insufficient');
    });

    test('a weak group the evidence does not require changes nothing', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: {
          pass_threshold: 0.5,
          group_by: 'kind',
          evidence: { required_groups: ['x'] },
        },
      });

      const run = await runSync({ evalId, failingItems: twenty.slice(15) });

      expect(run.verdict).toBe('supported');
      expect(reasonFor(run, { kind: 'group', name: 'y' })).toBeUndefined();
    });
  });

  describe('evidence on the eval', () => {
    test('is stored, read back, kept when absent and cleared by null', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: { group_by: 'kind', evidence: { required_groups: ['x'] } },
      });

      const renamed = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ name: unique('verdict-renamed') });
      expect(renamed.status).toBe(200);
      expect(renamed.body.evidence).toEqual({ required_groups: ['x'] });

      const cleared = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ evidence: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.evidence).toBeNull();
    });

    test.each([
      ['required_groups without group_by', { required_groups: ['x'] }, {}],
      ['an empty group name', { required_groups: [''] }, { group_by: 'kind' }],
      [
        'a repeated group name',
        { required_groups: ['x', 'x'] },
        { group_by: 'kind' },
      ],
      [
        'an unknown key',
        { required_groups: ['x'], min_items: 3 },
        { group_by: 'kind' },
      ],
      ['a non-object', ['x'], { group_by: 'kind' }],
    ])('is refused with %s', async (_label, evidence, extra) => {
      const res = await createEval({
        datasetId: twentyId,
        body: { ...extra, evidence },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('round-trips through a formation template', async () => {
      const create = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('verdict-stack'),
          template: {
            resources: {
              Gate: {
                type: 'eval',
                properties: {
                  name: unique('verdict-formation-eval'),
                  agent_id: agentId,
                  dataset_id: twentyId,
                  scorers: [{ type: 'contains', value: 'ok' }],
                  pass_threshold: 0.5,
                  group_by: 'kind',
                  evidence: { required_groups: ['x', 'y'] },
                },
              },
            },
          },
        });
      expect(create.status).toBe(201);

      const evalId = (
        create.body.resources as Array<{ physical_resource_id: string }>
      )[0].physical_resource_id;
      const evaluation = await asUser().get(`/api/v1/evals/${evalId}`);
      expect(evaluation.status).toBe(200);
      expect(evaluation.body.evidence).toEqual({ required_groups: ['x', 'y'] });
    });

    test('clearing group_by while groups are required is refused', async () => {
      const evalId = await evalOf({
        datasetId: twentyId,
        body: { group_by: 'kind', evidence: { required_groups: ['x'] } },
      });

      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ group_by: null });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  test('eval_runs.completed carries the verdict and its reasons', async () => {
    const evalId = await evalOf({
      datasetId: twentyId,
      body: { pass_threshold: 0.5 },
    });

    const captured: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type === 'eval_runs.completed') captured.push(event);
    };
    eventBus.on('soat:event', handler);
    let run: RunBody;
    try {
      run = await runSync({ evalId });
      for (let tick = 0; tick < 100 && captured.length === 0; tick += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    } finally {
      eventBus.off('soat:event', handler);
    }

    const event = captured.find((candidate) => {
      return candidate.resourceId === run.id;
    });
    expect(event?.data).toMatchObject({
      verdict: 'supported',
      verdict_reasons: [expect.objectContaining({ scope: { kind: 'run' } })],
      agent_id: agentId,
    });
    expect(event?.data).not.toHaveProperty('passed');
  });
});
