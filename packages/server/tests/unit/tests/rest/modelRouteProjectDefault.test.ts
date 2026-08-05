import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { resetModelRouteBreakers } from 'src/lib/modelRouteBreaker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The project-default half of the model-routing PRD (Phase 3): a consumer that
 * binds neither `model_route_id` nor `ai_provider_id` inherits its project's
 * `default_model_route_id`, and the two write-time guards keep "this consumer has
 * no model at all" unrepresentable.
 *
 * Failover runs for real against local OpenAI-compatible stub servers (the
 * `modelRouteFailover.test.ts` pattern), so the inheritance chain, the composite
 * model, and the post-call metering attribution all execute end-to-end. Nothing
 * owned is mocked.
 */

const ACTIONS = [
  'model-routes:CreateModelRoute',
  'model-routes:DeleteModelRoute',
  'ai-providers:CreateAiProvider',
  'agents:CreateAgent',
  'agents:CreateAgentGeneration',
  'generations:GetGeneration',
  'agents:DeleteAgent',
  'chats:CreateChat',
  'chats:GetChat',
  'chats:DeleteChat',
  'chats:CreateChatCompletionForChat',
  'discussions:CreateDiscussion',
  'discussions:GetDiscussion',
  'discussions:UpdateDiscussion',
  'discussions:DeleteDiscussion',
  'discussions:CreateDiscussionRun',
];

type LlmStub = {
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
};

const chatCompletion = (args: { model: string; content: string }) => {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: args.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: args.content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
};

const startLlmStub = async (
  replyFor: () => { status: number; body: unknown }
): Promise<LlmStub> => {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const reply = replyFor();
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => {
      return requests;
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          return err ? reject(err) : resolve();
        });
      });
    },
  };
};

describe('Project default model route', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let projectDbId: number;
  const openServers: LlmStub[] = [];

  /** The default route's two targets: the first always 500s, the second serves. */
  let failing: LlmStub;
  let healthy: LlmStub;
  let defaultRouteId: string;
  let healthyProviderDbId: number;

  const track = (server: LlmStub): LlmStub => {
    openServers.push(server);
    return server;
  };

  const createProvider = async (args: {
    name: string;
    baseUrl: string;
    defaultModel: string;
    projectPublicId?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: args.projectPublicId ?? projectId,
        name: args.name,
        provider: 'ollama',
        default_model: args.defaultModel,
        base_url: args.baseUrl,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createRoute = async (args: {
    name: string;
    targets: Array<Record<string, unknown>>;
    projectPublicId?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/model-routes')
      .send({
        project_id: args.projectPublicId ?? projectId,
        name: args.name,
        targets: args.targets,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const patchProject = (body: Record<string, unknown>) => {
    return authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${projectId}`)
      .send(body);
  };

  const setDefault = async (routeId: string | null): Promise<void> => {
    const res = await patchProject({ default_model_route_id: routeId });
    expect(res.status).toBe(200);
  };

  /**
   * Polls for the fire-and-forget metering write rather than sleeping, then
   * returns the row so the served target can be asserted. `source` is only
   * visible in the idempotency key (`completion:{source}:{uuid}`), so the query
   * matches on the attribution columns and the count of matching rows is what
   * proves the served target was metered.
   */
  const awaitUsageEvent = async (args: {
    model: string;
    aiProviderDbId: number;
    after: number;
  }): Promise<InstanceType<typeof db.UsageEvent> | undefined> => {
    let event: InstanceType<typeof db.UsageEvent> | undefined;
    for (let attempt = 0; attempt < 200 && !event; attempt += 1) {
      const rows = await db.UsageEvent.findAll({
        where: {
          projectId: projectDbId,
          meterType: 'llm_tokens',
          model: args.model,
          aiProviderId: args.aiProviderDbId,
        },
        order: [['id', 'ASC']],
      });
      if (rows.length > args.after) event = rows[rows.length - 1];
      await new Promise((resolve) => {
        return setImmediate(resolve);
      });
    }
    return event;
  };

  const countUsageEvents = async (args: {
    model: string;
    aiProviderDbId: number;
  }): Promise<number> => {
    return db.UsageEvent.count({
      where: {
        projectId: projectDbId,
        meterType: 'llm_tokens',
        model: args.model,
        aiProviderId: args.aiProviderDbId,
      },
    });
  };

  /**
   * Consumers created by a test that inherit the default. They must be removed
   * before the default is cleared, or the second write-time guard (409) fires and
   * leaks into the next test — the same guard these tests assert.
   */
  const inheritors: Array<{ path: string; id: string }> = [];

  const trackInheritor = (path: string, id: string): string => {
    inheritors.push({ path, id });
    return id;
  };

  const clearDefault = async (): Promise<void> => {
    while (inheritors.length > 0) {
      const { path, id } = inheritors.pop()!;
      // An agent needs `force` to clear the generations it accumulated during
      // the test; chats and discussions take no such flag.
      const query = path === 'agents' ? '?force=true' : '';
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/${path}/${id}${query}`
      );
      expect(res.status).toBe(204);
    }
    await setDefault(null);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'mrdefault',
      policyActions: ACTIONS,
      createOtherProject: true,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
      attributes: ['id'],
    });
    projectDbId = (project as unknown as { id: number }).id;

    failing = track(
      await startLlmStub(() => {
        return { status: 500, body: { error: 'provider on fire' } };
      })
    );
    healthy = track(
      await startLlmStub(() => {
        return chatCompletion({
          model: 'default-healthy-model',
          content: 'served by the project default',
        });
      })
    );

    const healthyProviderId = await createProvider({
      name: 'mrdefault-healthy',
      baseUrl: healthy.baseUrl,
      defaultModel: 'default-healthy-model',
    });
    const healthyProvider = await db.AiProvider.findOne({
      where: { publicId: healthyProviderId },
      attributes: ['id'],
    });
    healthyProviderDbId = (healthyProvider as unknown as { id: number }).id;

    defaultRouteId = await createRoute({
      name: 'project-default',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrdefault-failing',
            baseUrl: failing.baseUrl,
            defaultModel: 'default-failing-model',
          }),
          model: 'default-failing-model',
        },
        {
          ai_provider_id: healthyProviderId,
          model: 'default-healthy-model',
        },
      ],
    });
  });

  beforeEach(() => {
    // Breaker state is process-wide and keyed by (provider, model); every test
    // here drives the same failing target, so it must be reset between them.
    resetModelRouteBreakers();
  });

  afterAll(async () => {
    await Promise.all(
      openServers.map((server) => {
        return server.close();
      })
    );
  });

  // ── The project field ──────────────────────────────────────────────────

  describe('PATCH /projects/:project_id default_model_route_id', () => {
    test('defaults to null and round-trips a route in the same project', async () => {
      const before = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(before.status).toBe(200);
      expect(before.body.default_model_route_id).toBeNull();

      const res = await patchProject({
        default_model_route_id: defaultRouteId,
      });
      expect(res.status).toBe(200);
      expect(res.body.default_model_route_id).toBe(defaultRouteId);

      const after = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(after.body.default_model_route_id).toBe(defaultRouteId);

      await setDefault(null);
    });

    test('a route from another project returns 400', async () => {
      const otherRouteId = await createRoute({
        name: 'other-project-default',
        projectPublicId: otherProjectId,
        targets: [
          {
            ai_provider_id: await createProvider({
              name: 'mrdefault-other',
              baseUrl: healthy.baseUrl,
              defaultModel: 'other-model',
              projectPublicId: otherProjectId,
            }),
            model: 'other-model',
          },
        ],
      });

      const res = await patchProject({
        default_model_route_id: otherRouteId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_ROUTE_NOT_FOUND');
      expect(res.body.error.message).toMatch(/not found in this project/);
    });

    test('an unknown route returns 400', async () => {
      const res = await patchProject({
        default_model_route_id: 'route_doesnotexist0',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_ROUTE_NOT_FOUND');
    });

    test('clearing a default nothing inherits returns 200', async () => {
      await setDefault(defaultRouteId);
      const res = await patchProject({ default_model_route_id: null });
      expect(res.status).toBe(200);
      expect(res.body.default_model_route_id).toBeNull();
    });

    test('a PATCH naming no field at all still returns 400', async () => {
      const res = await patchProject({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/default_model_route_id/);
    });

    test('unauthenticated PATCH returns 401', async () => {
      const res = await authenticatedTestClient('not-a-token')
        .patch(`/api/v1/projects/${projectId}`)
        .send({ default_model_route_id: defaultRouteId });
      expect(res.status).toBe(401);
    });

    test('a non-admin PATCH returns 403', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ default_model_route_id: defaultRouteId });
      expect(res.status).toBe(403);
    });
  });

  // ── Guard 1: a consumer must be resolvable ─────────────────────────────

  describe('a consumer that binds neither field', () => {
    test('agent create returns 400 without a default and 201 with one', async () => {
      await setDefault(null);

      const rejected = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, name: 'Unbound Agent' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
      expect(rejected.body.error.message).toMatch(
        /binds neither ai_provider_id nor model_route_id/
      );

      await setDefault(defaultRouteId);

      const accepted = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, name: 'Inheriting Agent' });
      expect(accepted.status).toBe(201);
      expect(accepted.body.ai_provider_id).toBeNull();
      expect(accepted.body.model_route_id).toBeNull();
      trackInheritor('agents', accepted.body.id);

      await clearDefault();
    });

    test('chat create returns 400 without a default and 201 with one', async () => {
      await setDefault(null);

      const rejected = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId, name: 'Unbound Chat' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.message).toMatch(/binds neither/);

      await setDefault(defaultRouteId);

      const accepted = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId, name: 'Inheriting Chat' });
      expect(accepted.status).toBe(201);
      expect(accepted.body.ai_provider_id).toBeNull();
      trackInheritor('chats', accepted.body.id);

      await clearDefault();
    });

    test('discussion create returns 400 without a default and 201 with one', async () => {
      await setDefault(null);

      const rejected = await authenticatedTestClient(userToken)
        .post('/api/v1/discussions')
        .send({ project_id: projectId, name: 'Unbound Discussion' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.message).toMatch(/binds neither/);

      await setDefault(defaultRouteId);

      const accepted = await authenticatedTestClient(userToken)
        .post('/api/v1/discussions')
        .send({ project_id: projectId, name: 'Inheriting Discussion' });
      expect(accepted.status).toBe(201);
      expect(accepted.body.ai_provider_id).toBeNull();
      trackInheritor('discussions', accepted.body.id);

      await clearDefault();
    });

    test('a chat declaring model without a provider returns 400', async () => {
      await setDefault(defaultRouteId);

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          project_id: projectId,
          name: 'Model Without Provider',
          model: 'gpt-4o-mini',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(
        /model requires an ai_provider_id/
      );

      await clearDefault();
    });
  });

  // ── Guard 2: clearing an inherited default ─────────────────────────────

  describe('clearing an inherited default', () => {
    test('returns 409 naming the count, while repointing stays free', async () => {
      await setDefault(defaultRouteId);

      const agent = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, name: 'Inheritor For 409' });
      expect(agent.status).toBe(201);

      const cleared = await patchProject({ default_model_route_id: null });
      expect(cleared.status).toBe(409);
      expect(cleared.body.error.code).toBe('PROJECT_DEFAULT_ROUTE_INHERITED');
      expect(cleared.body.error.meta.inheritors).toBeGreaterThanOrEqual(1);
      expect(cleared.body.error.meta.sample).toContain(agent.body.id);

      // Repointing to another route is the switch the feature exists for, so it
      // is never blocked.
      const secondRouteId = await createRoute({
        name: 'repointed-default',
        targets: [
          {
            ai_provider_id: await createProvider({
              name: 'mrdefault-repointed',
              baseUrl: healthy.baseUrl,
              defaultModel: 'default-healthy-model',
            }),
            model: 'default-healthy-model',
          },
        ],
      });
      const repointed = await patchProject({
        default_model_route_id: secondRouteId,
      });
      expect(repointed.status).toBe(200);
      expect(repointed.body.default_model_route_id).toBe(secondRouteId);

      // The next generation runs on the new route's targets.
      const generated = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agent.body.id}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });
      expect(generated.status).toBe(200);
      const record = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${generated.body.id}`
      );
      expect(record.body.routing.route_id).toBe(secondRouteId);

      trackInheritor('agents', agent.body.id);
      await clearDefault();
    });
  });

  // ── Route deletion ────────────────────────────────────────────────────

  describe("DELETE /model-routes/:route_id for a project's default", () => {
    test('returns 409', async () => {
      const routeId = await createRoute({
        name: 'delete-guarded-default',
        targets: [
          {
            ai_provider_id: await createProvider({
              name: 'mrdefault-delete-guard',
              baseUrl: healthy.baseUrl,
              defaultModel: 'default-healthy-model',
            }),
            model: 'default-healthy-model',
          },
        ],
      });
      await setDefault(routeId);

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/model-routes/${routeId}`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MODEL_ROUTE_HAS_DEPENDENTS');
      expect(res.body.error.meta.projects).toBe(1);
      expect(res.body.error.meta.sample).toContain(projectId);

      await clearDefault();

      const afterClear = await authenticatedTestClient(userToken).delete(
        `/api/v1/model-routes/${routeId}`
      );
      expect(afterClear.status).toBe(204);
    });
  });

  // ── Inheritance at runtime ────────────────────────────────────────────

  describe('runtime inheritance', () => {
    test('an inheriting chat completes via the second target and meters it', async () => {
      await setDefault(defaultRouteId);

      const chat = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId, name: 'Routed Chat' });
      expect(chat.status).toBe(201);
      expect(chat.body.ai_provider_id).toBeNull();

      trackInheritor('chats', chat.body.id);

      const failingBefore = failing.requests();
      const eventsBefore = await countUsageEvents({
        model: 'default-healthy-model',
        aiProviderDbId: healthyProviderDbId,
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chat.body.id}/completions`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe(
        'served by the project default'
      );
      // Target 0 was tried and failed over, not skipped.
      expect(failing.requests()).toBe(failingBefore + 1);

      // Metering names the target that actually served — not the route, and not
      // the target the call started on.
      const event = await awaitUsageEvent({
        model: 'default-healthy-model',
        aiProviderDbId: healthyProviderDbId,
        after: eventsBefore,
      });
      expect(event).toBeDefined();
      expect(event?.provider).toBe('ollama');
      expect(event?.aiProviderId).toBe(healthyProviderDbId);
      // Never the route itself: PriceBook is keyed by (ai_provider_id, model).
      expect(event?.model).not.toBe(defaultRouteId);

      await clearDefault();
    });

    test('an inheriting discussion run completes via the second target and meters it', async () => {
      await setDefault(defaultRouteId);

      const discussion = await authenticatedTestClient(userToken)
        .post('/api/v1/discussions')
        .send({
          project_id: projectId,
          name: 'Routed Discussion',
          participants: [{ name: 'Alpha', prompt: 'Argue for.' }],
        });
      expect(discussion.status).toBe(201);
      expect(discussion.body.ai_provider_id).toBeNull();
      trackInheritor('discussions', discussion.body.id);

      const eventsBefore = await countUsageEvents({
        model: 'default-healthy-model',
        aiProviderDbId: healthyProviderDbId,
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${discussion.body.id}/runs`)
        .send({ topic: 'Should we ship on Friday?' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');

      const event = await awaitUsageEvent({
        model: 'default-healthy-model',
        aiProviderDbId: healthyProviderDbId,
        after: eventsBefore,
      });
      expect(event).toBeDefined();
      expect(event?.aiProviderId).toBe(healthyProviderDbId);

      await clearDefault();
    });

    test('a consumer with an explicit pin ignores the default entirely', async () => {
      const pinnedStub = track(
        await startLlmStub(() => {
          return chatCompletion({
            model: 'pinned-model',
            content: 'served by the pin',
          });
        })
      );
      const pinnedProviderId = await createProvider({
        name: 'mrdefault-pinned',
        baseUrl: pinnedStub.baseUrl,
        defaultModel: 'pinned-model',
      });

      await setDefault(defaultRouteId);

      const chat = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          project_id: projectId,
          name: 'Pinned Chat',
          ai_provider_id: pinnedProviderId,
        });
      expect(chat.status).toBe(201);
      expect(chat.body.ai_provider_id).toBe(pinnedProviderId);

      const failingBefore = failing.requests();
      const healthyBefore = healthy.requests();

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chat.body.id}/completions`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('served by the pin');
      // Neither of the default route's targets was consulted.
      expect(failing.requests()).toBe(failingBefore);
      expect(healthy.requests()).toBe(healthyBefore);

      await authenticatedTestClient(userToken).delete(
        `/api/v1/chats/${chat.body.id}`
      );
      await clearDefault();
    });

    test('an inheriting agent generation records the inherited route', async () => {
      await setDefault(defaultRouteId);

      const agent = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, name: 'Inheriting Gen Agent' });
      expect(agent.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agent.body.id}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.output.model).toBe('default-healthy-model');

      const record = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${res.body.id}`
      );
      expect(record.body.routing).toMatchObject({
        route_id: defaultRouteId,
        target_index: 1,
        fallbacks: 1,
      });

      trackInheritor('agents', agent.body.id);
      await clearDefault();
    });
  });

  // ── Unpinning an existing consumer ────────────────────────────────────

  describe('unpinning a consumer onto the default', () => {
    test('a discussion PATCH with ai_provider_id null inherits, and 400s without a default', async () => {
      const pinnedProviderId = await createProvider({
        name: 'mrdefault-unpin-source',
        baseUrl: healthy.baseUrl,
        defaultModel: 'default-healthy-model',
      });

      const discussion = await authenticatedTestClient(userToken)
        .post('/api/v1/discussions')
        .send({
          project_id: projectId,
          name: 'Unpinnable Discussion',
          ai_provider_id: pinnedProviderId,
        });
      expect(discussion.status).toBe(201);

      const withoutDefault = await authenticatedTestClient(userToken)
        .patch(`/api/v1/discussions/${discussion.body.id}`)
        .send({ ai_provider_id: null });
      expect(withoutDefault.status).toBe(400);
      expect(withoutDefault.body.error.message).toMatch(/binds neither/);

      await setDefault(defaultRouteId);

      const withDefault = await authenticatedTestClient(userToken)
        .patch(`/api/v1/discussions/${discussion.body.id}`)
        .send({ ai_provider_id: null });
      expect(withDefault.status).toBe(200);
      expect(withDefault.body.ai_provider_id).toBeNull();

      trackInheritor('discussions', discussion.body.id);
      await clearDefault();
    });
  });
});
