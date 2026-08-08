import type http from 'node:http';

import { app } from 'src/app';
import { db } from 'src/db';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';
import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Covers the platform *self-call* path: a `soat` tool reaches the REST API over
 * a loopback HTTP request to `http://localhost:$PORT` (`executeSoatTool`), so
 * these tests bind the worker's own port — like `mcp.test.ts` — instead of
 * relying on `app.callback()`. Without a listener the self-call is refused and
 * the behaviour under test (the response's *status*) never happens.
 *
 * Two concerns live here because both are properties of that one path:
 *   1. a non-2xx self-call must fail the tool call, not return the error body
 *      as a successful result;
 *   2. a run driven by the background worker must still carry a principal, so
 *      a `soat` tool node authenticates — and never exceeds the credential
 *      that started the run.
 */
let httpServer: http.Server;

beforeAll(async () => {
  // Drive the queue explicitly instead of racing the in-process worker kick,
  // so a run's settled state is observable at a known point.
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
  const port = parseInt(process.env.PORT || '15047', 10);
  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(port, resolve);
    httpServer.once('error', reject);
  });
});

afterAll(async () => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
  await new Promise<void>((resolve, reject) => {
    if (!httpServer) return resolve();
    httpServer.close((err) => {
      return err ? reject(err) : resolve();
    });
  });
});

describe('SOAT self-call', () => {
  let adminToken: string;
  let userToken: string;
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
});
