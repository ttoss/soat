import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';
import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Covers the platform *self-call* path: a `soat` tool reaching the REST API
 * through `executeSoatTool`.
 *
 * That path used to be a loopback HTTP request to `http://localhost:$PORT`, so
 * this file bound the worker's own port — like `mcp.test.ts` still does — or
 * every self-call was refused before the behaviour under test could happen.
 * Since #888 the action is served in-process, and the listener is gone: these
 * tests now pass on `app.callback()` alone, which is itself part of the
 * evidence that no self-call goes back over the wire.
 *
 * Three concerns live here because all three are properties of that one path:
 *   1. a non-2xx self-call must fail the tool call, not return the error body
 *      as a successful result;
 *   2. a run driven by the background worker must still carry a principal, so
 *      a `soat` tool node authenticates — and never exceeds the credential
 *      that started the run;
 *   3. the same holds for a workflow-dispatched *agent*, whose generation is
 *      just as request-less as a durable run (#884).
 */

/**
 * The tool result the model was handed back, parsed out of the follow-up
 * completion request captured by a stub provider. `undefined` when the
 * generation never got that far.
 *
 * This — not the generation's status — is the assertion for every
 * authentication test here: the AI SDK turns a thrown tool error into a
 * `tool-error` part fed back to the model, so a generation whose self-call was
 * refused still reports `completed` (#884).
 */
const toolResultFromFollowUp = (
  completionBodies: Record<string, unknown>[]
): unknown => {
  for (const body of completionBodies) {
    const messages = body.messages as
      { role: string; content?: unknown }[] | undefined;
    const toolMessage = messages?.find((m) => {
      return m.role === 'tool';
    });
    if (toolMessage) return toolMessage.content;
  }
  return undefined;
};

beforeAll(() => {
  // Drive the queue explicitly instead of racing the in-process worker kick,
  // so a run's settled state is observable at a known point.
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
});

afterAll(() => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
});

describe('SOAT self-call', () => {
  let adminToken: string;
  let userToken: string;
  let userPublicId: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'soatselfcall',
      policyActions: [
        'tools:CreateTool',
        'tools:ListTools',
        'tools:GetTool',
        'tools:CallTool',
        'agents:GetAgent',
        'agents:CreateAgentGeneration',
        'orchestrations:CreateOrchestration',
        'orchestrations:GetOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'workflows:CreateWorkflow',
        'workflows:GetWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:TransitionTask',
      ],
      createNoPermUser: false,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userPublicId = setup.userId;
    projectId = setup.projectId;
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('a soat action that responds non-2xx fails the call instead of returning the error body', async () => {
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-get-agent',
          type: 'soat',
          actions: ['get-agent'],
        });
      expect(toolRes.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${toolRes.body.id}/call`)
        .send({
          action: 'get-agent',
          input: { agent_id: 'agent_nonexistent' },
        });

      // The self-call 404s. Before this was fixed the body came back as a
      // successful tool result, so a caller could not tell failure from data.
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('TOOL_HTTP_ERROR');
      expect(response.body.error.meta.tool_status_code).toBe(404);
    });
  });

  /**
   * The action's query string (#924). `buildPathFn` substitutes path params
   * only; every `in: query` parameter is built separately by `buildQueryFn`, and
   * the SOAT tool path used to drop it entirely — so a `list-*` action returned
   * everything the credential could see no matter what the model asked for, and
   * a `preset_parameters` value targeting a query parameter had no effect at
   * all. The failure was silent: the call succeeded with a superset.
   *
   * Asserted through `POST /tools/:id/call` because that is where both halves
   * are observable — the model-supplied argument and the preset — and one shape
   * per case: supplied, preset, and omitted.
   */
  describe('query parameters on a soat action (#924)', () => {
    let otherProjectId: string;
    let soatToolId: string;
    let presetSoatToolId: string;

    const listedToolNames = async (args: {
      toolId: string;
      input: Record<string, unknown>;
    }): Promise<string[]> => {
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/tools/${args.toolId}/call`)
        .send({ action: 'list-tools', input: args.input });
      expect(res.status).toBe(200);
      const listing = res.body as { data?: { name?: string }[] };
      expect(Array.isArray(listing.data)).toBe(true);
      return listing.data!.map((entry) => {
        return entry.name as string;
      });
    };

    const createTool = async (body: Record<string, unknown>) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send(body);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    beforeAll(async () => {
      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'soatselfcall-query-other' });
      expect(projectRes.status).toBe(201);
      otherProjectId = projectRes.body.id as string;

      // One marker tool per project: which of the two comes back is the whole
      // assertion, and the admin can see both when nothing scopes the call.
      await createTool({
        project_id: projectId,
        name: 'q924-in-scope',
        type: 'client',
      });
      await createTool({
        project_id: otherProjectId,
        name: 'q924-out-of-scope',
        type: 'client',
      });

      soatToolId = await createTool({
        project_id: projectId,
        name: 'q924-soat',
        type: 'soat',
        actions: ['list-tools'],
      });
      presetSoatToolId = await createTool({
        project_id: projectId,
        name: 'q924-soat-preset',
        type: 'soat',
        actions: ['list-tools'],
        preset_parameters: { project_id: projectId },
      });
    });

    test('a query parameter supplied by the caller scopes the action', async () => {
      const names = await listedToolNames({
        toolId: soatToolId,
        input: { project_id: otherProjectId },
      });
      expect(names).toContain('q924-out-of-scope');
      expect(names).not.toContain('q924-in-scope');
    });

    test('a query parameter supplied via preset_parameters scopes the action', async () => {
      const names = await listedToolNames({
        toolId: presetSoatToolId,
        input: {},
      });
      expect(names).toContain('q924-in-scope');
      expect(names).not.toContain('q924-out-of-scope');
    });

    test('an omitted query parameter is absent rather than sent as a literal', async () => {
      // Nothing scopes this call, so the admin sees both projects — which also
      // pins that no `project_id=undefined` reached the route.
      const names = await listedToolNames({ toolId: soatToolId, input: {} });
      expect(names).toContain('q924-in-scope');
      expect(names).toContain('q924-out-of-scope');
    });
  });

  describe('background-driven runs', () => {
    const createSoatToolNodeOrchestration = async (args: {
      token: string;
      name: string;
      toolId: string;
      action: string;
      input?: Record<string, unknown>;
    }): Promise<string> => {
      const res = await authenticatedTestClient(args.token)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: args.name,
          nodes: [
            {
              id: 'call',
              type: 'tool',
              tool_id: args.toolId,
              operation_id: args.action,
              input_mapping: args.input ?? {},
            },
          ],
          edges: [],
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    /**
     * Starts a run in the default durable mode (no `wait`), then drives the
     * queue the way the worker process would. Returns the settled run row.
     */
    const runInBackground = async (args: {
      token: string;
      orchestrationId: string;
    }) => {
      const startRes = await authenticatedTestClient(args.token)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: args.orchestrationId });
      expect(startRes.status).toBe(201);
      expect(startRes.body.status).toBe('queued');

      const claimed = await drainQueueOnce();
      expect(claimed).toBeGreaterThanOrEqual(1);

      const run = await db.OrchestrationRun.findOne({
        where: { publicId: startRes.body.id },
      });
      return run!;
    };

    test('a soat tool node authenticates as the principal that started the run', async () => {
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-list-tools-bg',
          type: 'soat',
          actions: ['list-tools'],
        });
      expect(toolRes.status).toBe(201);

      const orchestrationId = await createSoatToolNodeOrchestration({
        token: userToken,
        name: 'bg-soat-list',
        toolId: toolRes.body.id,
        action: 'list-tools',
        input: { project_id: projectId },
      });

      const run = await runInBackground({
        token: userToken,
        orchestrationId,
      });

      // Before the run carried a principal the worker drove it with no auth
      // header at all, so the self-call came back 401 and the node failed.
      expect(run.error).toBeNull();
      expect(run.status).toBe('succeeded');

      // The node artifact is the real listing, which only an authenticated,
      // project-scoped call can return.
      const artifacts = run.artifacts as Record<string, unknown>;
      const listing = artifacts.call as { data?: { name?: string }[] };
      expect(Array.isArray(listing.data)).toBe(true);
      expect(
        listing.data!.some((entry) => {
          return entry.name === 'soat-list-tools-bg';
        })
      ).toBe(true);
    });

    /**
     * The transition a background-driven run made, found by name. Attribution
     * is asserted on *this* row rather than the task's first: the creation row
     * names whoever called `POST /tasks` directly, which is an ordinary
     * request-bound credential and was never the gap.
     */
    const finishRowOf = async (taskPublicId: string) => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskPublicId}/history`
      );
      expect(res.status).toBe(200);
      const rows = res.body as {
        transition: string | null;
        principal_kind: string | null;
        principal_id: string | null;
      }[];
      const row = rows.find((entry) => {
        return entry.transition === 'finish';
      });
      expect(row).toBeDefined();
      return row!;
    };

    /**
     * The end-to-end shape this whole mechanism exists for: a workflow state
     * dispatches an orchestration, and that run moves the task on with a `soat`
     * tool node. A task-dispatched run is always durable, so before runs
     * carried a principal this could not work at all — the self-call had no
     * credential.
     */
    test('an orchestration dispatched by a workflow state can transition its own task', async () => {
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-transition-task',
          type: 'soat',
          actions: ['transition-task'],
        });
      expect(toolRes.status).toBe(201);

      const orchestrationId = await createSoatToolNodeOrchestration({
        token: userToken,
        name: 'advance-task',
        toolId: toolRes.body.id,
        action: 'transition-task',
        input: {
          task_id: { var: 'input.task_id' },
          transition: 'finish',
        },
      });

      const workflowRes = await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'self-advancing',
          states: [
            {
              name: 'working',
              initial: true,
              on_enter: {
                dispatch: {
                  kind: 'orchestration',
                  orchestration_id: orchestrationId,
                  input_mapping: { task_id: { var: 'task.id' } },
                },
              },
            },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['working'], to: 'done' }],
        });
      expect(workflowRes.status).toBe(201);

      const taskRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowRes.body.id,
          title: 'advances itself',
        });
      expect(taskRes.status).toBe(201);
      expect(taskRes.body.state).toBe('working');

      // The dispatch is fire-and-forget and its run is queued, so drive the
      // queue while polling the task — the observable side effect — rather than
      // sleeping for a fixed settle time.
      let state = taskRes.body.state as string;
      for (let attempt = 0; attempt < 40 && state !== 'done'; attempt += 1) {
        await drainQueueOnce();
        const poll = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskRes.body.id}`
        );
        state = poll.body.state as string;
      }
      await flushTaskAutomations();

      expect(state).toBe('done');

      // A user-started chain names that user. The `api_key` half of the same
      // assertion lives in the next test; both kinds are covered through a
      // background drive so neither can regress into the other.
      const row = await finishRowOf(taskRes.body.id);
      expect(row.principal_kind).toBe('user');
      expect(row.principal_id).toBe(userPublicId);
    });

    /**
     * The attribution half of the same path (#887). Authorization was already
     * correct — a key-started run is bounded by the key's policies (the next
     * test) — but the run-as token is JWT-shaped, so `apiKeyPublicId` was unset
     * and every downstream record named the *owning user* instead of the key
     * that actually acted. That erased the distinction task history exists to
     * record: two different keys held by one user were indistinguishable.
     */
    test('a task transitioned by a key-started run is attributed to the key, not its owning user', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  'tasks:CreateTask',
                  'tasks:GetTask',
                  'tasks:TransitionTask',
                  'tools:GetTool',
                  'tools:CallTool',
                  'orchestrations:GetOrchestration',
                  'orchestrations:StartRun',
                  'orchestrations:GetRun',
                  'workflows:GetWorkflow',
                ],
              },
            ],
          },
        });
      expect(policyRes.status).toBe(201);

      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          project_id: projectId,
          name: 'soatselfcall-attribution-key',
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const keyPublicId = keyRes.body.id as string;
      const rawKey = keyRes.body.key as string;

      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-transition-task-key',
          type: 'soat',
          actions: ['transition-task'],
        });
      expect(toolRes.status).toBe(201);

      const orchestrationId = await createSoatToolNodeOrchestration({
        token: userToken,
        name: 'advance-task-key',
        toolId: toolRes.body.id,
        action: 'transition-task',
        input: {
          task_id: { var: 'input.task_id' },
          transition: 'finish',
        },
      });

      const workflowRes = await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'self-advancing-key',
          states: [
            {
              name: 'working',
              initial: true,
              on_enter: {
                dispatch: {
                  kind: 'orchestration',
                  orchestration_id: orchestrationId,
                  input_mapping: { task_id: { var: 'task.id' } },
                },
              },
            },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['working'], to: 'done' }],
        });
      expect(workflowRes.status).toBe(201);

      // Created *by the key* — that is what makes the key the principal the
      // dispatch persists and the run later re-mints a token from.
      const taskRes = await authenticatedTestClient(rawKey)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowRes.body.id,
          title: 'advances itself as a key',
        });
      expect(taskRes.status).toBe(201);
      expect(taskRes.body.state).toBe('working');

      let state = taskRes.body.state as string;
      for (let attempt = 0; attempt < 40 && state !== 'done'; attempt += 1) {
        await drainQueueOnce();
        const poll = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskRes.body.id}`
        );
        state = poll.body.state as string;
      }
      await flushTaskAutomations();

      expect(state).toBe('done');

      const row = await finishRowOf(taskRes.body.id);
      expect(row.principal_kind).toBe('api_key');
      expect(row.principal_id).toBe(keyPublicId);
    });

    test('a run started by a scoped API key cannot exceed that key policies', async () => {
      // A key restricted to reads only. The run it starts must be able to list
      // (its own permission) but not create — the run-as identity is the key's
      // ceiling, never the owning user's.
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  'tools:ListTools',
                  'tools:GetTool',
                  'tools:CallTool',
                  'orchestrations:CreateOrchestration',
                  'orchestrations:GetOrchestration',
                  'orchestrations:StartRun',
                  'orchestrations:GetRun',
                ],
              },
            ],
          },
        });
      expect(policyRes.status).toBe(201);

      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          project_id: projectId,
          name: 'soatselfcall-readonly-key',
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      const listToolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-list-tools-key',
          type: 'soat',
          actions: ['list-tools'],
        });
      expect(listToolRes.status).toBe(201);

      const writeToolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-create-tool-key',
          type: 'soat',
          actions: ['create-tool'],
        });
      expect(writeToolRes.status).toBe(201);

      const readOrchestrationId = await createSoatToolNodeOrchestration({
        token: rawKey,
        name: 'bg-key-read',
        toolId: listToolRes.body.id,
        action: 'list-tools',
        input: { project_id: projectId },
      });
      const readRun = await runInBackground({
        token: rawKey,
        orchestrationId: readOrchestrationId,
      });
      expect(readRun.status).toBe('succeeded');

      const writeOrchestrationId = await createSoatToolNodeOrchestration({
        token: rawKey,
        name: 'bg-key-write',
        toolId: writeToolRes.body.id,
        action: 'create-tool',
        input: {
          project_id: projectId,
          name: 'escalated-tool',
          type: 'client',
        },
      });
      const writeRun = await runInBackground({
        token: rawKey,
        orchestrationId: writeOrchestrationId,
      });

      expect(writeRun.status).toBe('failed');
      // A run's persisted error keeps `code` and `message` only, so the
      // upstream status is asserted through the message it carries.
      const error = writeRun.error as { code?: string; message?: string };
      expect(error.code).toBe('TOOL_HTTP_ERROR');
      expect(error.message).toContain('403');

      const created = await db.Tool.findOne({
        where: { name: 'escalated-tool' },
      });
      expect(created).toBeNull();
    });
  });

  /**
   * The agent half of the same dispatch (#884). A workflow state with
   * `dispatch.kind: 'agent'` runs request-less exactly like an orchestration
   * dispatch, so an agent holding a `soat` tool needs the same run-as identity —
   * without one its self-call reaches the loopback unauthenticated.
   *
   * A local HTTP server stands in for the AI provider (the pattern used by
   * `rest/agentGeneration.test.ts`), so the real `ai.generateText` drives a real
   * tool call over real HTTP: the first completion asks for the `soat` tool, the
   * second answers with text once the tool result is back. The tool result the
   * model is handed is captured from the second request — that body is the
   * assertion, because it is the only place the *authenticated* answer becomes
   * observable.
   */
  describe('workflow agent dispatch', () => {
    let stubServer: http.Server;
    let listAgentId: string;
    let createAgentId: string;
    let completionBodies: Record<string, unknown>[] = [];

    // The one tool call the stub asks for, set per test. Ollama's OpenAI
    // endpoint ignores `tool_choice` (see tests.md — Deterministic model
    // behavior), and here the "model" is ours, so the forcing lives in the stub.
    let toolCall: { name: string; args: Record<string, unknown> };

    // Answers with the configured tool call the first time, then plain text
    // once the result is back — which is what ends the step loop.
    const stubBody = (body: Record<string, unknown>) => {
      const alreadyCalled = (body.messages as { role: string }[]).some((m) => {
        return m.role === 'tool';
      });

      const message = alreadyCalled
        ? { role: 'assistant', content: 'done' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_soat_1',
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              },
            ],
          };

      return {
        id: 'chatcmpl-soat',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message,
            finish_reason: alreadyCalled ? 'stop' : 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };

    const startStubServer = async (): Promise<string> => {
      stubServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          completionBodies.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stubBody(body)));
        });
      });
      await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = stubServer.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    };

    // An agent whose only tool is one `soat` action, so which action the model
    // reaches for is never in question.
    const createAgentWithSoatAction = async (args: {
      aiProviderId: string;
      name: string;
      action: string;
    }): Promise<string> => {
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: `${args.name}-tool`,
          type: 'soat',
          actions: [args.action],
        });
      expect(toolRes.status).toBe(201);

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: args.aiProviderId,
          name: args.name,
          tool_bindings: [{ tool_id: toolRes.body.id }],
        });
      expect(agentRes.status).toBe(201);
      return agentRes.body.id as string;
    };

    beforeAll(async () => {
      const stubBaseUrl = await startStubServer();

      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'soatselfcall-stub-provider',
          provider: 'ollama',
          default_model: 'stub-model',
          base_url: stubBaseUrl,
        });
      expect(aiProviderRes.status).toBe(201);

      listAgentId = await createAgentWithSoatAction({
        aiProviderId: aiProviderRes.body.id,
        name: 'soat-agent-list',
        action: 'list-tools',
      });
      createAgentId = await createAgentWithSoatAction({
        aiProviderId: aiProviderRes.body.id,
        name: 'soat-agent-create',
        action: 'create-tool',
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        if (!stubServer) return resolve();
        stubServer.close((err) => {
          return err ? reject(err) : resolve();
        });
      });
    });

    beforeEach(() => {
      completionBodies = [];
    });

    /**
     * Creates the workflow with the agent-dispatching entry state and a task on
     * it, as `token`. The task's creator is the principal the whole automation
     * chain acts as, so passing a raw `sk_` key here is what makes the dispatch
     * key-started. The workflow itself is authored by the admin, keeping the
     * key's own policies to exactly what the assertion is about.
     */
    const runAgentStateTask = async (args: {
      token: string;
      name: string;
      agentId: string;
    }) => {
      const workflowRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: args.name,
          states: [
            {
              name: 'working',
              initial: true,
              on_enter: {
                dispatch: {
                  kind: 'agent',
                  agent_id: args.agentId,
                  input_mapping: { prompt: 'Use your tool.' },
                },
              },
            },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['working'], to: 'done' }],
        });
      expect(workflowRes.status).toBe(201);

      const taskRes = await authenticatedTestClient(args.token)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowRes.body.id,
          title: args.name,
        });
      expect(taskRes.status).toBe(201);

      await flushTaskAutomations();

      const poll = await authenticatedTestClient(adminToken).get(
        `/api/v1/tasks/${taskRes.body.id}`
      );
      return poll.body;
    };

    test('an agent dispatched by a workflow state authenticates its soat tool as the principal that started the chain', async () => {
      toolCall = {
        name: 'soat-agent-list-tool_list-tools',
        args: { project_id: projectId },
      };

      const task = await runAgentStateTask({
        token: userToken,
        name: 'agent-dispatch-authenticated',
        agentId: listAgentId,
      });

      expect(task.active_dispatch.status).toBe('completed');

      // The listing is what only an authenticated, project-scoped call returns.
      // Before the agent branch carried a principal the self-call went out with
      // no header at all, so the model was handed the 401 instead.
      const result = JSON.stringify(toolResultFromFollowUp(completionBodies));
      expect(result).not.toContain('HttpToolError');
      expect(result).toContain('soat-agent-list-tool');
    });

    test('an agent dispatch by a task a scoped API key created cannot exceed that key policies', async () => {
      // The mirror of the orchestration escalation test above: a key allowed to
      // read but not to write. Re-minting must assert *who* started the chain,
      // never widen it to everything its owning user may do.
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  'tools:ListTools',
                  'tasks:CreateTask',
                  'tasks:GetTask',
                ],
              },
            ],
          },
        });
      expect(policyRes.status).toBe(201);

      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          project_id: projectId,
          name: 'soatselfcall-agent-readonly-key',
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      toolCall = {
        name: 'soat-agent-list-tool_list-tools',
        args: { project_id: projectId },
      };
      const readTask = await runAgentStateTask({
        token: rawKey,
        name: 'agent-dispatch-key-read',
        agentId: listAgentId,
      });
      expect(readTask.active_dispatch.status).toBe('completed');
      expect(
        JSON.stringify(toolResultFromFollowUp(completionBodies))
      ).toContain('soat-agent-list-tool');

      completionBodies = [];
      toolCall = {
        name: 'soat-agent-create-tool_create-tool',
        args: {
          project_id: projectId,
          name: 'agent-escalated-tool',
          type: 'client',
        },
      };
      await runAgentStateTask({
        token: rawKey,
        name: 'agent-dispatch-key-write',
        agentId: createAgentId,
      });

      // The write is refused at the self-call, so the model is handed the
      // failure rather than a created resource.
      expect(
        JSON.stringify(toolResultFromFollowUp(completionBodies))
      ).toContain('HttpToolError');
      const created = await db.Tool.findOne({
        where: { name: 'agent-escalated-tool' },
      });
      expect(created).toBeNull();
    });
  });

  /**
   * The approval half of the same gap (#894). When a human approves a tool call
   * an agent proposed, `fireContinuation` resumes that agent in a fresh
   * generation — with the resolving request already gone, and possibly days
   * later. So the continuation is as request-less as a workflow dispatch and
   * needs the same run-as identity, re-minted from the principal persisted on
   * the generation that proposed the call.
   *
   * The identity is deliberately **not** the approver's: a human decided
   * *whether* the proposed action happens, not *as whom*. Every test here
   * resolves as the admin while the chain was started by someone else, so an
   * implementation that re-minted from the resolver would fail the escalation
   * case rather than pass it silently.
   *
   * Approvals have no public create endpoint (they are filed by guardrails), so
   * items are seeded through `emitApproval` — the sanctioned "no entry point
   * exists" path (tests.md) — and resolved through REST as a real client would.
   */
  describe('tool-call approval continuation', () => {
    let stubServer: http.Server;
    let projectInternalId: number;
    let continuationAgentId: string;
    let completionBodies: Record<string, unknown>[] = [];

    // Same forcing as the dispatch suite: our stub is the "model", so the tool
    // call it asks for is set per test rather than left to the model's choice.
    let toolCall: { name: string; args: Record<string, unknown> };

    const stubBody = (body: Record<string, unknown>) => {
      const alreadyCalled = (body.messages as { role: string }[]).some((m) => {
        return m.role === 'tool';
      });
      const message = alreadyCalled
        ? { role: 'assistant', content: 'done' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_soat_approval',
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              },
            ],
          };

      return {
        id: 'chatcmpl-approval',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message,
            finish_reason: alreadyCalled ? 'stop' : 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };

    const startStubServer = async (): Promise<string> => {
      stubServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          completionBodies.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stubBody(body)));
        });
      });
      await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = stubServer.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    };

    beforeAll(async () => {
      const stubBaseUrl = await startStubServer();

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      projectInternalId = project!.id as number;

      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'approval-continuation-stub-provider',
          provider: 'ollama',
          default_model: 'stub-model',
          base_url: stubBaseUrl,
        });
      expect(aiProviderRes.status).toBe(201);

      // One agent holding both soat actions, so the *same* agent can be resumed
      // for a read and for a write and only the stub's chosen call differs.
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'approval-continuation-tool',
          type: 'soat',
          actions: ['list-tools', 'create-tool'],
        });
      expect(toolRes.status).toBe(201);

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderRes.body.id,
          name: 'approval-continuation-agent',
          tool_bindings: [{ tool_id: toolRes.body.id }],
        });
      expect(agentRes.status).toBe(201);
      continuationAgentId = agentRes.body.id as string;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        if (!stubServer) return resolve();
        stubServer.close((err) => {
          return err ? reject(err) : resolve();
        });
      });
    });

    beforeEach(() => {
      completionBodies = [];
    });

    /**
     * Runs the generation that "proposes" the call, as `token`. Its only job is
     * to be a real Generation row started by that credential — the principal it
     * records is what the continuation must later act as.
     */
    const proposingGeneration = async (token: string): Promise<string> => {
      toolCall = {
        name: 'approval-continuation-tool_list-tools',
        args: { project_id: projectId },
      };
      const res = await authenticatedTestClient(token)
        .post(`/api/v1/agents/${continuationAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'Use your tool.' }] });
      expect(res.status).toBe(200);
      return res.body.id as string;
    };

    /**
     * Seeds a tool_call approval against `generationId` and resolves it through
     * the REST approve route as the admin. The proposed action carries no
     * persisted tool id, so nothing is executed at resolution time and the test
     * is about the continuation generation alone.
     *
     * The continuation is fired and forgotten by the resolve route (the
     * manage-by-exception model), so this polls for the follow-up completion
     * rather than awaiting it.
     */
    const approveAndAwaitContinuation = async (args: {
      generationId: string;
      sessionId?: string;
    }): Promise<unknown> => {
      const item = await emitApproval({
        projectId: projectInternalId,
        origin: 'tool_call',
        proposedAction: { toolId: '', arguments: {} },
        expiresInSeconds: 3600,
        generationId: args.generationId,
        agentId: continuationAgentId,
        sessionId: args.sessionId,
      });

      completionBodies = [];
      const res = await authenticatedTestClient(adminToken).post(
        `/api/v1/approvals/${item.id}/approve`
      );
      expect(res.status).toBe(200);

      for (let i = 0; i < 80; i += 1) {
        const result = toolResultFromFollowUp(completionBodies);
        if (result !== undefined) return result;
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
      return undefined;
    };

    test('a continuation authenticates its soat tool as the principal that started the chain', async () => {
      const generationId = await proposingGeneration(userToken);

      toolCall = {
        name: 'approval-continuation-tool_list-tools',
        args: { project_id: projectId },
      };
      const result = await approveAndAwaitContinuation({ generationId });

      // The listing is what only an authenticated, project-scoped call returns.
      // Without a re-minted credential the self-call goes out with no header at
      // all and the model is handed the 401 instead.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('HttpToolError');
      expect(serialized).toContain('approval-continuation-tool');
    });

    test('a continuation of a chain a scoped API key started cannot exceed that key policies', async () => {
      // The mirror of the dispatch escalation test: a key allowed to read but
      // not to write. The approver here is the *admin*, who may do both — so a
      // continuation that acted as the resolver would create the tool.
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['tools:ListTools', 'agents:CreateAgentGeneration'],
              },
            ],
          },
        });
      expect(policyRes.status).toBe(201);

      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          project_id: projectId,
          name: 'soatselfcall-approval-readonly-key',
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      const readGenerationId = await proposingGeneration(rawKey);
      toolCall = {
        name: 'approval-continuation-tool_list-tools',
        args: { project_id: projectId },
      };
      expect(
        JSON.stringify(
          await approveAndAwaitContinuation({ generationId: readGenerationId })
        )
      ).toContain('approval-continuation-tool');

      const writeGenerationId = await proposingGeneration(rawKey);
      toolCall = {
        name: 'approval-continuation-tool_create-tool',
        args: {
          project_id: projectId,
          name: 'approval-escalated-tool',
          type: 'client',
        },
      };
      expect(
        JSON.stringify(
          await approveAndAwaitContinuation({ generationId: writeGenerationId })
        )
      ).toContain('HttpToolError');

      const created = await db.Tool.findOne({
        where: { name: 'approval-escalated-tool' },
      });
      expect(created).toBeNull();
    });

    test('a session-backed continuation carries the same credential', async () => {
      // The other branch of `fireContinuation`: the continuation appends to the
      // originating session's thread instead of starting a standalone
      // generation, so the credential has to reach `sendSessionMessage` too.
      const generationId = await proposingGeneration(userToken);

      const agent = await db.Agent.findOne({
        where: { publicId: continuationAgentId },
      });
      const conversation = await db.Conversation.create({
        projectId: projectInternalId,
      });
      const session = await db.Session.create({
        projectId: projectInternalId,
        agentId: agent!.id,
        conversationId: conversation.id,
        status: 'open',
      });

      toolCall = {
        name: 'approval-continuation-tool_list-tools',
        args: { project_id: projectId },
      };
      const result = await approveAndAwaitContinuation({
        generationId,
        sessionId: session.publicId,
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('HttpToolError');
      expect(serialized).toContain('approval-continuation-tool');
    });
  });
});
