import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ACTIONS = [
  'orchestrations:CreateOrchestration',
  'orchestrations:GetOrchestration',
  'orchestrations:UpdateOrchestration',
  'orchestrations:ListOrchestrationVersions',
  'orchestrations:GetOrchestrationVersion',
  'orchestrations:RestoreOrchestrationVersion',
  'orchestrations:StartRun',
  'orchestrations:GetRun',
  'formations:CreateFormation',
];

/**
 * An orchestration's `output_mapping` is the contract for what its run
 * returns: JSON Logic over the final `state`, so `output` keeps its shape
 * however the graph is wired inside.
 */
describe('Orchestration output_mapping', () => {
  let userToken: string;
  let projectId: string;
  let noPermToken: string;

  const nodes = (terminalId: string) => {
    return [
      {
        id: 'a',
        type: 'transform',
        expression: { cat: ['x'] },
        state_mapping: { 'state.first': { var: 'output.result' } },
      },
      { id: terminalId, type: 'transform', expression: { cat: ['y'] } },
    ];
  };

  const edges = (terminalId: string) => {
    return [{ from: 'a', to: terminalId }];
  };

  const createOrchestration = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'Output Mapping',
        nodes: nodes('b'),
        edges: edges('b'),
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const runToCompletion = async (orchestrationId: string) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestrationId, input: {} });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('succeeded');
    return res.body;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'orchout',
      policyActions: ACTIONS,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;
  });

  describe('run output', () => {
    test('without output_mapping, output is keyed by terminal node id', async () => {
      const orch = await createOrchestration({});
      expect(orch.output_mapping).toBeNull();

      const run = await runToCompletion(orch.id);
      expect(run.output).toEqual({ b: { result: 'y' } });
    });

    test('output_mapping shapes output from the final state', async () => {
      const orch = await createOrchestration({
        output_mapping: {
          first: { var: 'state.first' },
          last: { var: 'state.nodes.b.result' },
          constant: 'fixed',
        },
      });

      const run = await runToCompletion(orch.id);
      expect(run.output).toEqual({ first: 'x', last: 'y', constant: 'fixed' });

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${run.id}`
      );
      expect(read.body.output).toEqual(run.output);
    });

    test('renaming the terminal node leaves the mapped output unchanged', async () => {
      const orch = await createOrchestration({
        output_mapping: { first: { var: 'state.first' } },
      });
      const before = await runToCompletion(orch.id);

      const patched = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orch.id}`)
        .send({ nodes: nodes('c'), edges: edges('c') });
      expect(patched.status).toBe(200);

      const after = await runToCompletion(orch.id);
      expect(after.output).toEqual(before.output);
      expect(after.output).toEqual({ first: 'x' });
    });

    test('a dotted key builds a nested object', async () => {
      const orch = await createOrchestration({
        output_mapping: { 'summary.first': { var: 'state.first' } },
      });

      const run = await runToCompletion(orch.id);
      expect(run.output).toEqual({ summary: { first: 'x' } });
    });

    test('a key named like a JSON Logic operator is an output field', async () => {
      const orch = await createOrchestration({
        output_mapping: { cat: { var: 'state.first' } },
      });

      const run = await runToCompletion(orch.id);
      expect(run.output).toEqual({ cat: 'x' });
    });

    test('a missing state path maps to null', async () => {
      const orch = await createOrchestration({
        output_mapping: { absent: { var: 'state.never_written' } },
      });

      const run = await runToCompletion(orch.id);
      expect(run.output).toEqual({ absent: null });
    });

    test('a mapping that throws fails the run with no output', async () => {
      const orch = await createOrchestration({
        output_mapping: { first: { throw: 'bad mapping' } },
      });

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: orch.id, input: {} });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.output).toBeNull();
      expect(res.body.error).toEqual(
        expect.objectContaining({ code: 'UNKNOWN' })
      );
    });

    test('a sub_orchestration node reads the child run mapped output', async () => {
      const child = await createOrchestration({
        name: 'Output Mapping Child',
        output_mapping: { first: { var: 'state.first' } },
      });
      const parent = await createOrchestration({
        name: 'Output Mapping Parent',
        nodes: [
          {
            id: 'child',
            type: 'sub_orchestration',
            orchestration_id: child.id,
            state_mapping: { 'state.from_child': { var: 'output.first' } },
          },
        ],
        edges: [],
        output_mapping: { from_child: { var: 'state.from_child' } },
      });

      const run = await runToCompletion(parent.id);
      expect(run.output).toEqual({ from_child: 'x' });
    });
  });

  describe('writes', () => {
    test('unauthenticated create returns 401', async () => {
      const res = await testClient.post('/api/v1/orchestrations').send({
        project_id: projectId,
        name: 'No Auth',
        nodes: nodes('b'),
        edges: edges('b'),
        output_mapping: { first: { var: 'state.first' } },
      });
      expect(res.status).toBe(401);
    });

    test('create without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'No Perm',
          nodes: nodes('b'),
          edges: edges('b'),
          output_mapping: { first: { var: 'state.first' } },
        });
      expect(res.status).toBe(403);
    });

    test.each([
      ['an array', [{ var: 'state.first' }]],
      ['a string', 'state.first'],
      ['a number', 1],
    ])('create refuses output_mapping as %s', async (_label, value) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'Bad Mapping',
          nodes: nodes('b'),
          edges: edges('b'),
          output_mapping: value,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('update refuses a non-object output_mapping', async () => {
      const orch = await createOrchestration({});
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orch.id}`)
        .send({ output_mapping: ['nope'] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('update by a user outside the project returns 404', async () => {
      const orch = await createOrchestration({});
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/orchestrations/${orch.id}`)
        .send({ output_mapping: { first: { var: 'state.first' } } });
      expect(res.status).toBe(404);
    });

    test('update sets and null clears output_mapping, each a new version', async () => {
      const orch = await createOrchestration({});
      const mapping = { first: { var: 'state.first' } };

      const set = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orch.id}`)
        .send({ output_mapping: mapping });
      expect(set.status).toBe(200);
      expect(set.body.output_mapping).toEqual(mapping);
      expect(set.body.version).toBe(2);

      const cleared = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orch.id}`)
        .send({ output_mapping: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.output_mapping).toBeNull();
      expect(cleared.body.version).toBe(3);

      const run = await runToCompletion(orch.id);
      expect(run.output).toEqual({ b: { result: 'y' } });
    });
  });

  describe('formations', () => {
    test('an orchestration resource carries output_mapping', async () => {
      const mapping = { first: { var: 'state.first' } };
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'output-mapping-formation',
          template: {
            resources: {
              Flow: {
                type: 'orchestration',
                properties: {
                  name: 'formation-flow',
                  nodes: nodes('b'),
                  edges: edges('b'),
                  output_mapping: mapping,
                },
              },
            },
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      const orchestrationId = res.body.resources[0].physical_resource_id;
      const run = await runToCompletion(orchestrationId);
      expect(run.output).toEqual({ first: 'x' });
    });
  });

  describe('versions', () => {
    test('the archive carries output_mapping and a restore brings it back', async () => {
      const mapping = { first: { var: 'state.first' } };
      const orch = await createOrchestration({ output_mapping: mapping });

      const v1 = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/1`
      );
      expect(v1.body.config.output_mapping).toEqual(mapping);

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orch.id}`)
        .send({ output_mapping: null });

      const restored = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/1/restore`
      );
      expect(restored.status).toBe(200);
      expect(restored.body.output_mapping).toEqual(mapping);
    });
  });
});
