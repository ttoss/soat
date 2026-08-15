import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ORCHESTRATION_VERSION_ACTIONS = [
  'orchestrations:CreateOrchestration',
  'orchestrations:GetOrchestration',
  'orchestrations:UpdateOrchestration',
  'orchestrations:DeleteOrchestration',
  'orchestrations:ListOrchestrationVersions',
  'orchestrations:GetOrchestrationVersion',
  'orchestrations:RestoreOrchestrationVersion',
  'orchestrations:StartRun',
  'orchestrations:GetRun',
];

/**
 * Orchestration version history, on the shared archive engine (issue #872).
 *
 * Every assertion drives the REST entry point: versions are written by the
 * shared lib choke point in `orchestrations.ts`, so a create, a `PATCH` and a
 * restore are indistinguishable from here — and a formation apply, which goes
 * through the same `updateOrchestration`, leaves identical history.
 */
describe('Orchestration versions', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;

  const NODES_V1 = [
    { id: 'a', type: 'transform', expression: 'v1' },
    { id: 'b', type: 'transform', expression: 'downstream' },
  ];
  const EDGES_V1 = [{ from: 'a', to: 'b' }];

  const createOrchestration = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        nodes: NODES_V1,
        edges: EDGES_V1,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const patchOrchestration = async (
    id: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const res = await authenticatedTestClient(userToken)
      .patch(`/api/v1/orchestrations/${id}`)
      .send(body);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'orchver',
      policyActions: ORCHESTRATION_VERSION_ACTIONS,
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
    test('creating an orchestration archives version 1', async () => {
      const orch = await createOrchestration({
        name: 'Archive On Create',
        version_label: 'initial',
      });
      expect(orch.version).toBe(1);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/1`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^orch_ver_/);
      expect(res.body.orchestration_id).toBe(orch.id);
      expect(res.body.version).toBe(1);
      expect(res.body.config.nodes).toEqual(NODES_V1);
      expect(res.body.config.edges).toEqual(EDGES_V1);
      expect(res.body.label).toBe('initial');
      expect(res.body.created_by).toBe(userId);
      expect(res.body.created_at).toBeDefined();
    });

    test('the archived config carries the graph and nothing else', async () => {
      const orch = await createOrchestration({
        name: 'Config Shape',
        description: 'metadata that is not versioned',
        state_schema: { type: 'object' },
        input_schema: { type: 'object', properties: { topic: {} } },
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/1`
      );

      // Pinned deliberately. Only the graph is versioned: bumping the version
      // when a name or description changes would make two version numbers
      // denote the same topology, and the version number is exactly what a run
      // cites to say which topology it executed.
      expect(Object.keys(res.body.config).sort()).toEqual([
        'edges',
        'input_schema',
        'nodes',
        'state_schema',
      ]);
    });

    test('a graph change bumps the version and archives the new graph', async () => {
      const orch = await createOrchestration({ name: 'Bumps' });

      const updated = await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
        version_label: 'rewired',
      });
      expect(updated.version).toBe(2);

      const v1 = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/1`
      );
      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/2`
      );

      expect(v1.body.config.nodes).toHaveLength(2);
      expect(v2.body.config.nodes).toEqual([
        { id: 'a', type: 'transform', expression: 'v2' },
      ]);
      expect(v2.body.label).toBe('rewired');
    });

    test('a metadata-only edit archives no version', async () => {
      const orch = await createOrchestration({ name: 'Metadata Only' });

      const updated = await patchOrchestration(orch.id, {
        name: 'Metadata Only, Renamed',
        description: 'still the same graph',
      });

      expect(updated.version).toBe(1);
      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('re-writing the graph the orchestration already holds archives no version', async () => {
      const orch = await createOrchestration({ name: 'No-op Write' });

      const updated = await patchOrchestration(orch.id, {
        nodes: NODES_V1,
        edges: EDGES_V1,
      });

      expect(updated.version).toBe(1);
      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('a JSON Logic expression round-trips through the archive verbatim', async () => {
      // The graph is author-authored data the platform does not own: a `var`
      // path must survive archiving byte-for-byte, underscores included
      // (.claude/rules/case-convention.md).
      const nodes = [
        {
          id: 'gate',
          type: 'condition',
          expression: { '>': [{ var: 'state.max_daily_budget' }, 100] },
        },
      ];

      const orch = await createOrchestration({
        name: 'Author Payloads',
        nodes,
        edges: [],
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/1`
      );
      expect(res.body.config.nodes).toEqual(nodes);
    });
  });

  describe('pinning a run to the version it started on', () => {
    test('starting a run records the orchestration version it runs', async () => {
      const orch = await createOrchestration({ name: 'Pins At Start' });
      await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
      });

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orch.id, wait: true });

      expect(res.status).toBe(201);
      expect(res.body.orchestration_version).toBe(2);
    });
  });

  describe('GET /api/v1/orchestrations/:orchestration_id/versions', () => {
    let listedId: string;

    beforeAll(async () => {
      const orch = await createOrchestration({ name: 'Listed' });
      listedId = orch.id;
      await patchOrchestration(listedId, {
        nodes: [{ id: 'a', type: 'transform', expression: 'second' }],
        edges: [],
      });
      await patchOrchestration(listedId, {
        nodes: [{ id: 'a', type: 'transform', expression: 'third' }],
        edges: [],
      });
    });

    test('lists versions newest first', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${listedId}/versions`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(
        res.body.data.map((row: { version: number }) => {
          return row.version;
        })
      ).toEqual([3, 2, 1]);
      expect(res.body.data[0].config.nodes[0].expression).toBe('third');
    });

    test('honors limit and offset', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${listedId}/versions?limit=1&offset=1`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.limit).toBe(1);
      expect(res.body.offset).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].version).toBe(2);
    });

    test('unknown orchestration returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/orchestrations/orch_missing/versions'
      );
      expect(res.status).toBe(404);
    });

    test('an orchestration in another project resolves as not found', async () => {
      const other = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: otherProjectId,
          name: 'Other Project',
          nodes: NODES_V1,
          edges: EDGES_V1,
        });
      expect(other.status).toBe(201);

      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/orchestrations/${other.body.id}/versions`
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/orchestrations/${listedId}/versions`
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/orchestrations/:orchestration_id/versions/:version', () => {
    test('unknown version returns 404', async () => {
      const orch = await createOrchestration({ name: 'Missing Version Get' });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/99`
      );
      expect(res.status).toBe(404);
    });

    test('non-integer version returns 400', async () => {
      const orch = await createOrchestration({ name: 'Bad Version Get' });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/abc`
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/orchestrations/:orchestration_id/versions/:version/restore', () => {
    test('restore appends a new version rather than rewinding the counter', async () => {
      const orch = await createOrchestration({ name: 'Restorable' });
      await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(3);
      expect(res.body.nodes).toEqual(NODES_V1);
      expect(res.body.edges).toEqual(EDGES_V1);

      // Version 2 — the graph that was rolled back — is still retrievable, so a
      // run that executed it does not dangle.
      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/2`
      );
      expect(v2.status).toBe(200);
      expect(v2.body.config.nodes[0].expression).toBe('v2');

      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/3`
      );
      expect(v3.body.config.nodes).toEqual(NODES_V1);
      expect(v3.body.label).toBe('restored from v1');
      expect(v3.body.created_by).toBe(userId);
    });

    test('an explicit label annotates the version the restore creates', async () => {
      const orch = await createOrchestration({ name: 'Labelled Restore' });
      await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${orch.id}/versions/1/restore`)
        .send({ label: 'rollback to pre-incident graph' });

      expect(res.status).toBe(200);
      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions/3`
      );
      expect(v3.body.label).toBe('rollback to pre-incident graph');
    });

    test('restoring the live graph is a no-op that creates no version', async () => {
      const orch = await createOrchestration({ name: 'Restore Current' });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('restore leaves metadata untouched — only the graph rolls back', async () => {
      const orch = await createOrchestration({ name: 'Metadata Survives' });
      await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
      });
      await patchOrchestration(orch.id, {
        name: 'Renamed After The Edit',
        description: 'set after version 2',
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual(NODES_V1);
      expect(res.body.name).toBe('Renamed After The Edit');
      expect(res.body.description).toBe('set after version 2');
    });

    test('a restored graph keeps a node reference whose target is gone', async () => {
      // Deliberately a 200, not a 400. An orchestration's node references
      // (`agent_id`, `tool_id`, `orchestration_id`) resolve when a run reaches
      // the node, not when the graph is written — `assertOrchestrationValid` is a
      // static check, so restoring a graph is exactly as legal as authoring it
      // was. The dangling reference surfaces as a failed run, which is where it
      // surfaces on the create path too.
      const target = await createOrchestration({ name: 'Restore Target' });
      const orch = await createOrchestration({
        name: 'Dangling After Delete',
        nodes: [
          { id: 'a', type: 'sub_orchestration', orchestration_id: target.id },
        ],
        edges: [],
      });
      await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
      });

      const del = await authenticatedTestClient(userToken).delete(
        `/api/v1/orchestrations/${target.id}`
      );
      expect(del.status).toBe(204);

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/1/restore`
      );
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(3);
      expect(res.body.nodes[0].orchestration_id).toBe(target.id);
    });

    test('unknown version returns 404', async () => {
      const orch = await createOrchestration({
        name: 'Missing Version Restore',
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/99/restore`
      );
      expect(res.status).toBe(404);
    });

    test('non-integer version returns 400', async () => {
      const orch = await createOrchestration({ name: 'Bad Version Restore' });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/abc/restore`
      );
      expect(res.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post(
        '/api/v1/orchestrations/orch_whatever/versions/1/restore'
      );
      expect(res.status).toBe(401);
    });

    test('a user without RestoreOrchestrationVersion is refused', async () => {
      const orch = await createOrchestration({
        name: 'No Restore Permission',
      });

      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestrations/${orch.id}/versions/1/restore`
      );
      // `noPermToken` resolves to an empty project list. On a read that is a
      // 404 (nothing matches the filter); on a write it is a denial, and the
      // route says so before touching the orchestration (#1029).
      expect(res.status).toBe(403);
    });
  });

  describe('deletion', () => {
    test('deleting an orchestration removes its archived versions', async () => {
      const orch = await createOrchestration({
        name: 'Deleted With Versions',
      });
      await patchOrchestration(orch.id, {
        nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
        edges: [],
      });

      const del = await authenticatedTestClient(userToken).delete(
        `/api/v1/orchestrations/${orch.id}`
      );
      expect(del.status).toBe(204);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orch.id}/versions`
      );
      expect(versions.status).toBe(404);
    });
  });

  describe('a restricted API key', () => {
    /**
     * A project-scoped API key whose policy excludes `excludedAction`. Unlike
     * `noPermToken` — which resolves to an empty project list — this
     * reaches the route with a resolvable project and exercises the 403 branch.
     */
    const createRestrictedApiKey = async (excludedAction: string) => {
      const allowedActions = ORCHESTRATION_VERSION_ACTIONS.filter((action) => {
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

    test('without ListOrchestrationVersions returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'orchestrations:ListOrchestrationVersions'
      );
      const res = await authenticatedTestClient(rawKey).get(
        '/api/v1/orchestrations/orch_anything/versions'
      );
      expect(res.status).toBe(403);
    });

    test('without GetOrchestrationVersion returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'orchestrations:GetOrchestrationVersion'
      );
      const res = await authenticatedTestClient(rawKey).get(
        '/api/v1/orchestrations/orch_anything/versions/1'
      );
      expect(res.status).toBe(403);
    });

    test('without RestoreOrchestrationVersion returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'orchestrations:RestoreOrchestrationVersion'
      );
      const res = await authenticatedTestClient(rawKey).post(
        '/api/v1/orchestrations/orch_anything/versions/1/restore'
      );
      expect(res.status).toBe(403);
    });
  });
});
