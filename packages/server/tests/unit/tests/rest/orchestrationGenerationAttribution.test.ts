import { db } from 'src/db';
import * as agentGenerationModule from 'src/lib/agentGeneration';
import { createGenerationRecord } from 'src/lib/generations';
import { executeAndRecordNode } from 'src/lib/orchestrationNodeRecorder';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Reaching an agent node's generation from an orchestration run.
 *
 * A node execution row stores no generation id — the pointer lives on the
 * generation, next to the other attribution columns (`orchestration_run_id`,
 * `node_id`). This covers both halves of making that pointer usable:
 *
 * 1. the node's retry attempt is stamped alongside the run and node, so a
 *    retried node's generations are told apart rather than inferred from
 *    timestamps;
 * 2. `list-generations` can be filtered by run and node, which is what turns
 *    those columns into a way back from a run to what its agents actually did.
 */
describe('Orchestration → generation attribution', () => {
  let userToken: string;
  let adminToken: string;
  let projectId: string;
  let projectPk: number;
  let agentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'orchgenattr',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'agents:CreateAgent',
        'generations:ListGenerations',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectPk = project?.id as number;

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Orch Gen Attribution Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(aiProviderRes.status).toBe(201);

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'Orch Gen Attribution Agent',
        ai_provider_id: aiProviderRes.body.id,
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  const createRunRow = async () => {
    const orchRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: `Attribution Pipeline ${Date.now()}`,
        nodes: [
          {
            id: 'ask',
            type: 'agent',
            agent_id: agentId,
            input_mapping: { prompt: { var: 'question' } },
          },
        ],
        edges: [],
      });
    expect(orchRes.status).toBe(201);
    const orch = await db.Orchestration.findOne({
      where: { publicId: orchRes.body.id },
    });

    return db.OrchestrationRun.create({
      orchestrationId: orch?.id as number,
      projectId: projectPk,
      status: 'running',
      state: {},
      activeNodes: [],
      artifacts: {},
      input: {},
      startedAt: new Date(),
    });
  };

  const agentNodes = [
    {
      id: 'ask',
      type: 'agent' as const,
      agentId: '',
      inputMapping: { prompt: { var: 'question' } },
    },
  ];

  const stubGeneration = () => {
    return jest
      .spyOn(agentGenerationModule, 'createGeneration')
      .mockResolvedValue({
        id: 'gen_attr01',
        traceId: 'trc_attr01',
        status: 'completed',
        output: {
          model: 'llama3.2',
          content: 'ok',
          finishReason: 'stop',
        },
      });
  };

  describe('node attempt is stamped on the generation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('an agent node forwards run, node and attempt to the generation', async () => {
      const run = await createRunRow();
      const spy = stubGeneration();

      await executeAndRecordNode({
        nodeId: 'ask',
        runRecord: run,
        nodes: [{ ...agentNodes[0], agentId }],
        state: { question: 'hello' },
        projectIds: [projectPk],
        traceId: null,
        retryAttempt: 3,
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          orchestrationRunId: run.publicId as string,
          nodeId: 'ask',
          nodeAttempt: 3,
        })
      );
    });

    test('defaults to attempt 1 when the node is not being retried', async () => {
      const run = await createRunRow();
      const spy = stubGeneration();

      await executeAndRecordNode({
        nodeId: 'ask',
        runRecord: run,
        nodes: [{ ...agentNodes[0], agentId }],
        state: { question: 'hello' },
        projectIds: [projectPk],
        traceId: null,
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ nodeAttempt: 1 })
      );
    });
  });

  describe('GET /api/v1/generations — orchestration filters', () => {
    // Two runs' worth of real generation records, so the filters are asserted
    // against rows the production write path produces rather than a stub.
    const runA = 'orun_attrfiltera';
    const runB = 'orun_attrfilterb';

    beforeAll(async () => {
      const seed = async (args: {
        suffix: string;
        orchestrationRunId: string;
        nodeId: string;
        nodeAttempt: number;
      }) => {
        await createGenerationRecord({
          publicId: `gen_attrfilter_${args.suffix}`,
          projectId: projectPk,
          agentId,
          traceId: `trc_attrfilter_${args.suffix}`,
          orchestrationRunId: args.orchestrationRunId,
          nodeId: args.nodeId,
          nodeAttempt: args.nodeAttempt,
        });
      };

      await seed({
        suffix: 'a1',
        orchestrationRunId: runA,
        nodeId: 'ask',
        nodeAttempt: 1,
      });
      await seed({
        suffix: 'a2',
        orchestrationRunId: runA,
        nodeId: 'ask',
        nodeAttempt: 2,
      });
      await seed({
        suffix: 'a3',
        orchestrationRunId: runA,
        nodeId: 'summarize',
        nodeAttempt: 1,
      });
      await seed({
        suffix: 'b1',
        orchestrationRunId: runB,
        nodeId: 'ask',
        nodeAttempt: 1,
      });
    });

    test('filters by orchestration_run_id', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?orchestration_run_id=${runA}`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      const runIds = res.body.data.map(
        (g: { orchestration_run_id: string }) => {
          return g.orchestration_run_id;
        }
      );
      expect(new Set(runIds)).toEqual(new Set([runA]));
    });

    test('narrows to a single node with node_id', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?orchestration_run_id=${runA}&node_id=ask`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(
        res.body.data
          .map((g: { node_attempt: number }) => {
            return g.node_attempt;
          })
          .sort()
      ).toEqual([1, 2]);
    });

    test('exposes node_attempt on the generation', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?orchestration_run_id=${runB}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].orchestration_run_id).toBe(runB);
      expect(res.body.data[0].node_id).toBe('ask');
      expect(res.body.data[0].node_attempt).toBe(1);
    });

    test('an unknown run returns an empty page rather than an error', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/generations?orchestration_run_id=orun_doesnotexist'
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/generations?orchestration_run_id=${runA}`
      );

      expect(res.status).toBe(401);
    });
  });
});
