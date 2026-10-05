import { authenticatedTestClient } from '../testClient';
import { setupProjectWithUsers } from './bootstrap';

/**
 * The resources a formation module's declarations point at, created once per
 * test file through the API, and the round trip every built-in resource type
 * is driven through: deploy, read back through a plan, update, tear down.
 */
export type FormationModuleFixtures = {
  adminToken: string;
  projectId: string;
  aiProviderId: string;
  agentId: string;
  actorId: string;
  memoryStoreId: string;
  converterToolId: string;
  policyA: string;
  policyB: string;
  datasetId: string;
};

export const setupFormationModuleFixtures = async (args: {
  prefix: string;
}): Promise<FormationModuleFixtures> => {
  const setup = await setupProjectWithUsers({
    prefix: args.prefix,
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  const client = authenticatedTestClient(setup.adminToken);
  const projectId = setup.projectId;

  const created = async (path: string, body: object): Promise<string> => {
    const res = await client.post(`/api/v1/${path}`).send(body);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const aiProviderId = await created('ai-providers', {
    project_id: projectId,
    name: `${args.prefix} Provider`,
    provider: 'openai',
    default_model: 'gpt-4o',
  });
  const policy = (action: string) => {
    return created('policies', {
      document: { statement: [{ effect: 'Allow', action: [action] }] },
    });
  };

  return {
    adminToken: setup.adminToken,
    projectId,
    aiProviderId,
    agentId: await created('agents', {
      project_id: projectId,
      ai_provider_id: aiProviderId,
      name: `${args.prefix} Agent`,
    }),
    actorId: await created('actors', {
      project_id: projectId,
      name: `${args.prefix} Actor`,
    }),
    memoryStoreId: await created('memory-stores', {
      project_id: projectId,
      name: `${args.prefix} MemoryStore`,
    }),
    converterToolId: await created('tools', {
      project_id: projectId,
      name: `${args.prefix}-converter`,
      type: 'builtin',
      description: 'converter tool',
      actions: ['list-tools'],
    }),
    policyA: await policy('agents:CreateAgentGeneration'),
    policyB: await policy('agents:GetAgent'),
    datasetId: await created('datasets', {
      project_id: projectId,
      name: `${args.prefix} Suite`,
    }),
  };
};

export type RoundTripCase = {
  name: string;
  type: string;
  /** The resource's own read route, for the teardown check. */
  route: string;
  build: (seed: string) => {
    create: Record<string, unknown>;
    expectRead: Record<string, unknown>;
    /** A full declaration replacing `create`; omit for an immutable type. */
    update?: Record<string, unknown>;
    expectAfterUpdate?: Record<string, unknown>;
  };
};

let counter = 0;

/** Woven into every field that carries a uniqueness constraint. */
export const nextSeed = (): string => {
  counter += 1;
  return `s${String(counter)}`;
};

export const templateOf = (
  type: string,
  properties: Record<string, unknown>
) => {
  return { resources: { Res: { type, properties } } };
};

/** The single change a plan of a one-resource template reports. */
export const planChange = async (args: {
  fx: FormationModuleFixtures;
  formationId: string;
  template: unknown;
}) => {
  const res = await authenticatedTestClient(args.fx.adminToken)
    .post('/api/v1/formations/plan')
    .send({
      project_id: args.fx.projectId,
      formation_id: args.formationId,
      template: args.template,
    });
  expect(res.status).toBe(200);
  expect(res.body.changes).toHaveLength(1);
  return res.body.changes[0];
};

const expectGone = async (args: {
  fx: FormationModuleFixtures;
  route: string;
  physicalId: string;
}) => {
  const client = authenticatedTestClient(args.fx.adminToken);
  // An item has no read route of its own; its dataset lists what it holds.
  if (args.route === 'dataset-items') {
    const items = await client.get(
      `/api/v1/datasets/${args.fx.datasetId}/items`
    );
    expect(items.status).toBe(200);
    expect(
      items.body.data.map((item: { id: string }) => {
        return item.id;
      })
    ).not.toContain(args.physicalId);
    return;
  }
  const gone = await client.get(`/api/v1/${args.route}/${args.physicalId}`);
  expect(gone.status).toBe(404);
};

/**
 * Deploys the case, reads it back through a plan, applies its update and reads
 * that back, then tears the formation down and checks the resource is gone.
 */
export const runRoundTrip = async (args: {
  fx: FormationModuleFixtures;
  testCase: RoundTripCase;
}): Promise<void> => {
  const { fx, testCase } = args;
  const client = authenticatedTestClient(fx.adminToken);
  const spec = testCase.build(nextSeed());

  const created = await client.post('/api/v1/formations').send({
    project_id: fx.projectId,
    name: `round-trip-${nextSeed()}`,
    template: templateOf(testCase.type, spec.create),
  });
  expect(created.status).toBe(201);
  expect(created.body.error).toBeNull();
  expect(created.body.status).toBe('active');
  const physicalId: string = created.body.resources[0].physical_resource_id;

  const unchanged = await planChange({
    fx,
    formationId: created.body.id,
    template: templateOf(testCase.type, spec.create),
  });
  expect(unchanged.diff.current).toMatchObject(spec.expectRead);

  if (spec.update) {
    const updated = await client
      .put(`/api/v1/formations/${created.body.id}`)
      .send({ template: templateOf(testCase.type, spec.update) });
    expect(updated.status).toBe(200);
    expect(updated.body.error).toBeNull();
    expect(updated.body.status).toBe('active');

    const afterUpdate = await planChange({
      fx,
      formationId: created.body.id,
      template: templateOf(testCase.type, spec.update),
    });
    expect(afterUpdate.diff.current).toMatchObject(
      spec.expectAfterUpdate ?? {}
    );
  }

  const deleted = await client.delete(`/api/v1/formations/${created.body.id}`);
  expect(deleted.status).toBe(200);
  await expectGone({ fx, route: testCase.route, physicalId });
};
