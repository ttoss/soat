import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ROUTE_ACTIONS = [
  'model-routes:ListModelRoutes',
  'model-routes:CreateModelRoute',
  'model-routes:GetModelRoute',
  'model-routes:UpdateModelRoute',
  'model-routes:DeleteModelRoute',
  'ai-providers:CreateAiProvider',
  'agents:CreateAgent',
  'agents:UpdateAgent',
  'agents:GetAgent',
  'agents:DeleteAgent',
  'ai-providers:DeleteAiProvider',
];

describe('Model Routes', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;
  let providerA: string;
  let providerB: string;
  let otherProjectProvider: string;

  const createProvider = async (args: {
    project: string;
    name: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: args.project,
        name: args.name,
        provider: 'ollama',
        default_model: 'stub-model',
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createRoute = (
    token: string,
    body: Record<string, unknown>,
    project = projectId
  ) => {
    return authenticatedTestClient(token)
      .post('/api/v1/model-routes')
      .send({ project_id: project, ...body });
  };

  /**
   * A project-scoped API key carrying the model-route policy minus
   * `excludedAction`. Needed because a user with **no** policies resolves to an
   * empty project list (404), while a project-scoped key that cannot perform the
   * action resolves to `null` — the genuine 403 branch.
   */
  const createRestrictedApiKey = async (
    excludedAction: string
  ): Promise<string> => {
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ROUTE_ACTIONS.filter((action) => {
                return action !== excludedAction;
              }),
            },
          ],
        },
      });
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: `No ${excludedAction} Key`,
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    expect(keyRes.status).toBe(201);
    return keyRes.body.key as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'mroutes',
      policyActions: ROUTE_ACTIONS,
      createOtherProject: true,
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    noPermToken = setup.noPermToken!;

    providerA = await createProvider({ project: projectId, name: 'mroutes-a' });
    providerB = await createProvider({ project: projectId, name: 'mroutes-b' });
    otherProjectProvider = await createProvider({
      project: otherProjectId,
      name: 'mroutes-other',
    });
  });

  describe('POST /api/v1/model-routes', () => {
    test('creates a route with defaults and echoes the ordered targets', async () => {
      const res = await createRoute(userToken, {
        name: 'defaults-route',
        targets: [
          { ai_provider_id: providerA, model: 'primary-model' },
          { ai_provider_id: providerB, model: 'fallback-model' },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^route_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.name).toBe('defaults-route');
      expect(res.body.targets).toEqual([
        { ai_provider_id: providerA, model: 'primary-model' },
        { ai_provider_id: providerB, model: 'fallback-model' },
      ]);
      expect(res.body.retry_on).toEqual([
        'provider_error',
        'timeout',
        'rate_limited',
      ]);
      expect(res.body.failure_threshold).toBe(3);
      expect(res.body.cooldown_seconds).toBe(60);
      expect(res.body.created_at).toBeDefined();
    });

    test('stores explicit retry, timeout, and breaker configuration', async () => {
      const res = await createRoute(userToken, {
        name: 'explicit-route',
        targets: [
          {
            ai_provider_id: providerA,
            model: 'primary-model',
            timeout_seconds: 30,
            max_retries: 2,
          },
        ],
        retry_on: ['rate_limited'],
        failure_threshold: 5,
        cooldown_seconds: 120,
      });

      expect(res.status).toBe(201);
      expect(res.body.targets[0].timeout_seconds).toBe(30);
      expect(res.body.targets[0].max_retries).toBe(2);
      expect(res.body.retry_on).toEqual(['rate_limited']);
      expect(res.body.failure_threshold).toBe(5);
      expect(res.body.cooldown_seconds).toBe(120);
    });

    test('rejects a target referencing another project’s provider', async () => {
      const res = await createRoute(userToken, {
        name: 'cross-project-route',
        targets: [{ ai_provider_id: otherProjectProvider, model: 'm' }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
      expect(res.body.error.message).toMatch(/not found in this project/);
    });

    test('rejects a route whose total attempt budget exceeds the cap, naming the total', async () => {
      const res = await createRoute(userToken, {
        name: 'too-many-attempts',
        targets: [
          { ai_provider_id: providerA, model: 'm', max_retries: 5 },
          { ai_provider_id: providerB, model: 'm', max_retries: 5 },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain('12 total attempts');
      expect(res.body.error.message).toContain('maximum is 10');
    });

    test('accepts a route sitting exactly on the attempt cap', async () => {
      const res = await createRoute(userToken, {
        name: 'exactly-ten-attempts',
        targets: [
          { ai_provider_id: providerA, model: 'm', max_retries: 4 },
          { ai_provider_id: providerB, model: 'm', max_retries: 4 },
        ],
      });

      expect(res.status).toBe(201);
    });

    test('rejects an empty target list', async () => {
      const res = await createRoute(userToken, {
        name: 'no-targets',
        targets: [],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/non-empty array/);
    });

    test('rejects an unknown field inside a target', async () => {
      const res = await createRoute(userToken, {
        name: 'unknown-target-field',
        targets: [{ ai_provider_id: providerA, model: 'm', weight: 3 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects an unknown retry_on class', async () => {
      const res = await createRoute(userToken, {
        name: 'bad-retry-on',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
        retry_on: ['meltdown'],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a non-positive failure_threshold', async () => {
      const res = await createRoute(userToken, {
        name: 'bad-threshold',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
        failure_threshold: 0,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/failure_threshold/);
    });

    test('rejects a duplicate name in the same project', async () => {
      const body = {
        name: 'duplicate-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      };
      expect((await createRoute(userToken, body)).status).toBe(201);

      const res = await createRoute(userToken, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/model-routes').send({
        project_id: projectId,
        name: 'unauth',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });
      expect(res.status).toBe(401);
    });

    test('user without the permission returns 403', async () => {
      const res = await createRoute(noPermToken, {
        name: 'forbidden',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/model-routes', () => {
    test('lists the project’s routes', async () => {
      await createRoute(userToken, {
        name: 'listed-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/model-routes?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(
        res.body.data.some((route: { name: string }) => {
          return route.name === 'listed-route';
        })
      ).toBe(true);
      expect(typeof res.body.total).toBe('number');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/model-routes');
      expect(res.status).toBe(401);
    });

    test('user without the permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/model-routes?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/model-routes/{route_id}', () => {
    test('returns the route', async () => {
      const created = await createRoute(userToken, {
        name: 'gettable-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/model-routes/${created.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.name).toBe('gettable-route');
    });

    test('a caller scoped to one project cannot read another project’s route', async () => {
      const created = await createRoute(
        adminToken,
        {
          name: 'other-project-route',
          targets: [{ ai_provider_id: otherProjectProvider, model: 'm' }],
        },
        otherProjectId
      );
      expect(created.status).toBe(201);

      // A key bound to `projectId` resolves only that project, so a route in
      // otherProjectId is a not-found rather than a readable body.
      const scopedKey = await createRestrictedApiKey('model-routes:NoneOfThem');
      const res = await authenticatedTestClient(scopedKey).get(
        `/api/v1/model-routes/${created.body.id}`
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('project-scoped key without GetModelRoute returns 403', async () => {
      const key = await createRestrictedApiKey('model-routes:GetModelRoute');
      const res = await authenticatedTestClient(key).get(
        '/api/v1/model-routes/route_whatever00000'
      );
      expect(res.status).toBe(403);
    });

    test('unknown route returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/model-routes/route_doesnotexist000'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/model-routes/route_x');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/v1/model-routes/{route_id}', () => {
    test('replaces targets and updates the breaker configuration', async () => {
      const created = await createRoute(userToken, {
        name: 'updatable-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/model-routes/${created.body.id}`)
        .send({
          name: 'updated-route',
          targets: [{ ai_provider_id: providerB, model: 'n', max_retries: 1 }],
          retry_on: ['provider_error'],
          cooldown_seconds: 15,
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('updated-route');
      expect(res.body.targets).toEqual([
        { ai_provider_id: providerB, model: 'n', max_retries: 1 },
      ]);
      expect(res.body.retry_on).toEqual(['provider_error']);
      expect(res.body.cooldown_seconds).toBe(15);
      // Untouched fields keep their stored value.
      expect(res.body.failure_threshold).toBe(3);
    });

    test('keeping its own name is not a conflict', async () => {
      const created = await createRoute(userToken, {
        name: 'same-name-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/model-routes/${created.body.id}`)
        .send({ name: 'same-name-route', cooldown_seconds: 30 });

      expect(res.status).toBe(200);
      expect(res.body.cooldown_seconds).toBe(30);
    });

    test('rejects replacement targets that exceed the attempt cap', async () => {
      const created = await createRoute(userToken, {
        name: 'cap-on-update',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/model-routes/${created.body.id}`)
        .send({
          targets: [{ ai_provider_id: providerA, model: 'm', max_retries: 10 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('11 total attempts');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .put('/api/v1/model-routes/route_x')
        .send({ cooldown_seconds: 5 });
      expect(res.status).toBe(401);
    });

    test('project-scoped key without UpdateModelRoute returns 403', async () => {
      const key = await createRestrictedApiKey('model-routes:UpdateModelRoute');
      const res = await authenticatedTestClient(key)
        .put('/api/v1/model-routes/route_whatever00000')
        .send({ cooldown_seconds: 5 });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/model-routes/{route_id}', () => {
    test('deletes an unreferenced route', async () => {
      const created = await createRoute(userToken, {
        name: 'deletable-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/model-routes/${created.body.id}`
      );
      expect(res.status).toBe(204);

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/model-routes/${created.body.id}`
      );
      expect(after.status).toBe(404);
    });

    test('returns 409 while an agent still references the route', async () => {
      const created = await createRoute(userToken, {
        name: 'referenced-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'Routed Agent',
          model_route_id: created.body.id,
        });
      expect(agentRes.status).toBe(201);

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/model-routes/${created.body.id}`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MODEL_ROUTE_HAS_DEPENDENTS');
      expect(res.body.error.meta.agents).toBe(1);
      expect(res.body.error.meta.sample).toEqual([agentRes.body.id]);

      // Repointing the agent releases the route.
      await authenticatedTestClient(userToken)
        .delete(`/api/v1/agents/${agentRes.body.id}`)
        .expect(204);
      const retry = await authenticatedTestClient(userToken).delete(
        `/api/v1/model-routes/${created.body.id}`
      );
      expect(retry.status).toBe(204);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.delete('/api/v1/model-routes/route_x');
      expect(res.status).toBe(401);
    });

    test('project-scoped key without DeleteModelRoute returns 403', async () => {
      const key = await createRestrictedApiKey('model-routes:DeleteModelRoute');
      const res = await authenticatedTestClient(key).delete(
        '/api/v1/model-routes/route_whatever00000'
      );
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/ai-providers/{ai_provider_id}', () => {
    test('a provider named by a route target is a live reference (409)', async () => {
      const provider = await createProvider({
        project: projectId,
        name: 'mroutes-referenced',
      });
      const route = await createRoute(userToken, {
        name: 'provider-reference-route',
        targets: [{ ai_provider_id: provider, model: 'm' }],
      });
      expect(route.status).toBe(201);

      // No FK protects a target (it names its provider inside JSONB), so the
      // guard must be explicit — and `force` must not override it.
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/ai-providers/${provider}?force=true`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('AI_PROVIDER_HAS_DEPENDENTS');
      expect(res.body.error.message).toMatch(/1 model route\(s\)/);
      expect(res.body.error.meta.modelRouteCount).toBe(1);
      expect(res.body.error.meta.modelRouteIds).toEqual([route.body.id]);
      expect(res.body.error.meta.forcible).toBe(false);

      await authenticatedTestClient(userToken)
        .delete(`/api/v1/model-routes/${route.body.id}`)
        .expect(204);
      await authenticatedTestClient(userToken)
        .delete(`/api/v1/ai-providers/${provider}`)
        .expect(204);
    });
  });

  describe('Agent model binding exclusivity', () => {
    let routeId: string;

    beforeAll(async () => {
      const created = await createRoute(userToken, {
        name: 'agent-binding-route',
        targets: [{ ai_provider_id: providerA, model: 'm' }],
      });
      routeId = created.body.id;
    });

    const createAgent = (body: Record<string, unknown>) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, ...body });
    };

    test('a route-only agent reports the route and a null provider', async () => {
      const res = await createAgent({
        name: 'Route Only',
        model_route_id: routeId,
      });

      expect(res.status).toBe(201);
      expect(res.body.model_route_id).toBe(routeId);
      expect(res.body.ai_provider_id).toBeNull();
    });

    test('a pinned agent reports a null route', async () => {
      const res = await createAgent({
        name: 'Pinned',
        ai_provider_id: providerA,
      });

      expect(res.status).toBe(201);
      expect(res.body.ai_provider_id).toBe(providerA);
      expect(res.body.model_route_id).toBeNull();
    });

    test('setting both a provider and a route returns 400', async () => {
      const res = await createAgent({
        name: 'Both',
        ai_provider_id: providerA,
        model_route_id: routeId,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/mutually exclusive/);
    });

    // "Neither" means "inherit the project's default_model_route_id" since the
    // project-default amendment, so it is only an error while the project has no
    // default — which this fixture project does not.
    test('setting neither returns 400 when the project has no default', async () => {
      const res = await createAgent({ name: 'Neither' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(
        /binds neither ai_provider_id nor model_route_id/
      );
      expect(res.body.error.message).toMatch(/no default_model_route_id/);
    });

    test('combining model with a route returns 400', async () => {
      const res = await createAgent({
        name: 'Route And Model',
        model_route_id: routeId,
        model: 'gpt-4o-mini',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/each route target names its own/);
    });

    test('a route from another project is not usable', async () => {
      const otherRoute = await createRoute(
        adminToken,
        {
          name: 'other-project-agent-route',
          targets: [{ ai_provider_id: otherProjectProvider, model: 'm' }],
        },
        otherProjectId
      );

      const res = await createAgent({
        name: 'Cross Project Route',
        model_route_id: otherRoute.body.id,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_ROUTE_NOT_FOUND');
    });

    test('switching a pinned agent to a route requires clearing the pin', async () => {
      const agent = await createAgent({
        name: 'Switcher',
        ai_provider_id: providerA,
      });

      const conflicting = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ model_route_id: routeId });
      expect(conflicting.status).toBe(400);
      expect(conflicting.body.error.message).toMatch(/mutually exclusive/);

      const switched = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ model_route_id: routeId, ai_provider_id: null });
      expect(switched.status).toBe(200);
      expect(switched.body.model_route_id).toBe(routeId);
      expect(switched.body.ai_provider_id).toBeNull();

      // ...and back again.
      const reverted = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ model_route_id: null, ai_provider_id: providerA });
      expect(reverted.status).toBe(200);
      expect(reverted.body.ai_provider_id).toBe(providerA);
      expect(reverted.body.model_route_id).toBeNull();
    });

    // Clearing the pin leaves the agent bound to nothing, which is only
    // representable when its project has a default route to inherit — this
    // fixture project has none.
    test('clearing both bindings returns 400', async () => {
      const agent = await createAgent({
        name: 'Unbindable',
        ai_provider_id: providerA,
      });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ ai_provider_id: null });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(
        /binds neither ai_provider_id nor model_route_id/
      );
    });

    test('an unrelated partial update never trips the invariant', async () => {
      const agent = await createAgent({
        name: 'Untouched Binding',
        model_route_id: routeId,
      });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ instructions: 'be brief' });

      expect(res.status).toBe(200);
      expect(res.body.model_route_id).toBe(routeId);
    });
  });
});
