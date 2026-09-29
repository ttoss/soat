import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * Uncertainty on an eval run (the evaluations module doc — Uncertainty): the
 * pass rate carries a 95% Wilson interval, and a baseline comparison counts
 * the items that changed sides and the exact McNemar p-value of that split.
 * The statistics themselves are pinned in `lib/evaluationStatistics.test.ts`;
 * this file pins that a run reports them.
 */

type Message = { role: string; content: string };

const ITEMS = Array.from({ length: 12 }, (_, index) => {
  return `item-${index + 1}`;
});

describe('Evaluations — uncertainty', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let agentId: string;
  let datasetId: string;
  let erroringDatasetId: string;
  let seq = 0;

  // The stubbed agent answers `nope` for an item in this set and `ok`
  // otherwise, so each test sets the verdicts it compares.
  let failing = new Set<string>();

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createEval = async (dataset: string): Promise<string> => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('uncertainty-eval'),
        agent_id: agentId,
        dataset_id: dataset,
        scorers: [{ type: 'contains', value: 'ok' }],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const runEval = async (args: {
    evalId: string;
    failingItems: string[];
    baselineRunId?: string;
  }) => {
    failing = new Set(args.failingItems);
    const res = await asUser()
      .post(`/api/v1/evals/${args.evalId}/runs`)
      .send({ wait: true, baseline_run_id: args.baselineRunId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    return res.body as {
      id: string;
      aggregate_scores: {
        pass_rate: number | null;
        pass_rate_interval: {
          low: number;
          high: number;
          level: number;
        } | null;
        baseline?: {
          pass_rate_delta: number | null;
          flipped: { improved: number; regressed: number };
          p_value: number | null;
        };
      };
    };
  };

  const addItems = async (dataset: string, contents: string[]) => {
    for (const content of contents) {
      const res = await asUser()
        .post(`/api/v1/datasets/${dataset}/items`)
        .send({ input: [{ role: 'user', content }] });
      expect(res.status).toBe(201);
    }
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    // The LLM boundary: the reply is a function of the item, and an item
    // whose input says ERROR fails its generation, so it is errored.
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
      prefix: 'evaluncertainty',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:RunEval',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Uncertainty Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Uncertain Agent',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    const datasetRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'twelve-cases' });
    datasetId = datasetRes.body.id;
    await addItems(datasetId, ITEMS);

    const erroringRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'erroring-cases' });
    erroringDatasetId = erroringRes.body.id;
    await addItems(erroringDatasetId, ['ERROR-1', 'ERROR-2']);
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
  });

  describe('POST /api/v1/evals/{eval_id}/runs', () => {
    test('reports a 95% interval around the pass rate', async () => {
      const evalId = await createEval(datasetId);

      const run = await runEval({ evalId, failingItems: ITEMS.slice(6) });

      expect(run.aggregate_scores.pass_rate).toBe(0.5);
      const interval = run.aggregate_scores.pass_rate_interval!;
      expect(interval.low).toBeCloseTo(0.253782, 6);
      expect(interval.high).toBeCloseTo(0.746218, 6);
      expect(interval.level).toBe(0.95);
    });

    test('a run that scored nothing reports no interval', async () => {
      const evalId = await createEval(erroringDatasetId);

      const run = await runEval({ evalId, failingItems: [] });

      expect(run.aggregate_scores.pass_rate).toBeNull();
      expect(run.aggregate_scores.pass_rate_interval).toBeNull();
    });

    test('counts the items that changed sides against the baseline', async () => {
      const evalId = await createEval(datasetId);
      const baseline = await runEval({
        evalId,
        failingItems: ITEMS.slice(6),
      });

      const run = await runEval({
        evalId,
        failingItems: [],
        baselineRunId: baseline.id,
      });

      const comparison = run.aggregate_scores.baseline!;
      expect(comparison.pass_rate_delta).toBe(0.5);
      expect(comparison.flipped).toEqual({ improved: 6, regressed: 0 });
      expect(comparison.p_value).toBeCloseTo(0.03125, 12);
    });

    test('a split that sorts both ways is not evidence of a change', async () => {
      const evalId = await createEval(datasetId);
      const baseline = await runEval({
        evalId,
        failingItems: ['item-1', 'item-2', 'item-3'],
      });

      // item-1 and item-2 recover, item-4 breaks: a net gain of one item.
      const run = await runEval({
        evalId,
        failingItems: ['item-3', 'item-4'],
        baselineRunId: baseline.id,
      });

      const comparison = run.aggregate_scores.baseline!;
      expect(comparison.pass_rate_delta).toBeCloseTo(1 / 12, 12);
      expect(comparison.flipped).toEqual({ improved: 2, regressed: 1 });
      expect(comparison.p_value).toBe(1);
    });

    test('an unchanged agent flips nothing and reports p_value 1', async () => {
      const evalId = await createEval(datasetId);
      const baseline = await runEval({
        evalId,
        failingItems: ['item-1'],
      });

      const run = await runEval({
        evalId,
        failingItems: ['item-1'],
        baselineRunId: baseline.id,
      });

      const comparison = run.aggregate_scores.baseline!;
      expect(comparison.flipped).toEqual({ improved: 0, regressed: 0 });
      expect(comparison.p_value).toBe(1);
    });

    test('two runs that share no scored item report no p_value', async () => {
      const evalId = await createEval(erroringDatasetId);
      const baseline = await runEval({ evalId, failingItems: [] });

      const run = await runEval({
        evalId,
        failingItems: [],
        baselineRunId: baseline.id,
      });

      const comparison = run.aggregate_scores.baseline!;
      expect(comparison.pass_rate_delta).toBeNull();
      expect(comparison.flipped).toEqual({ improved: 0, regressed: 0 });
      expect(comparison.p_value).toBeNull();
    });
  });
});
