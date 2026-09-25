import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// A guardrail's context tool receives the proposed call nested under `call` at
// every gate site reachable without a model turn, and in the dry run, which
// calls it exactly as a real call would. The agent-turn and client-tool gates
// are pinned in `lib/guardrailContextToolInput.test.ts`.

describe('guardrail context tool', () => {
  let server: Server;
  let baseUrl: string;
  let contextRequests: Array<Record<string, unknown>> = [];

  let userToken: string;
  let projectId: string;
  let guardrailId: string;
  let refundToolId: string;

  const startServer = async (): Promise<string> => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/context') {
          contextRequests.push(raw ? JSON.parse(raw) : {});
          res.end(JSON.stringify({ tier: 'trusted' }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createTool = async (body: Record<string, unknown>): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createGuardrail = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const refundCall = (args: Record<string, unknown>) => {
    return {
      call: {
        action: 'refund',
        tool: { id: refundToolId, name: 'refund' },
        args,
      },
    };
  };

  beforeAll(async () => {
    baseUrl = await startServer();
    const setup = await setupProjectWithUsers({
      prefix: 'guardctx',
      policyActions: [
        'guardrails:CreateGuardrail',
        'guardrails:EvaluateGuardrail',
        'tools:CreateTool',
        'tools:GetTool',
        'tools:ListTools',
        'tools:CallTool',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const contextToolId = await createTool({
      name: 'fetch-context',
      type: 'http',
      execute: { url: `${baseUrl}/context`, method: 'POST' },
    });
    guardrailId = await createGuardrail({
      name: 'guardctx-trusted',
      document: {
        class: 'B',
        guard: { '==': [{ var: 'context.tier' }, 'trusted'] },
      },
      context_tool_id: contextToolId,
    });
    refundToolId = await createTool({
      name: 'refund',
      type: 'http',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
      },
      preset_parameters: { currency: 'usd' },
      execute: { url: `${baseUrl}/refund`, method: 'POST' },
      guardrail_ids: [guardrailId],
    });
  });

  afterEach(() => {
    contextRequests = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/tools/{tool_id}/call', () => {
    test('the context tool receives the call with presets applied', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${refundToolId}/call`)
        .send({ input: { amount: 4, approval_reasoning: 'asked' } });

      expect(response.status).toBe(200);
      expect(contextRequests).toEqual([
        refundCall({ amount: 4, currency: 'usd' }),
      ]);
      expect(Object.keys(contextRequests[0])).toEqual(['call']);
    });

    test('two identical calls in a row ask the context tool twice', async () => {
      for (let i = 0; i < 2; i += 1) {
        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/tools/${refundToolId}/call`)
          .send({ input: { amount: 1 } });
        expect(response.status).toBe(200);
      }

      expect(contextRequests).toEqual([
        refundCall({ amount: 1, currency: 'usd' }),
        refundCall({ amount: 1, currency: 'usd' }),
      ]);
    });

    test('a pipeline step asks the context tool about the step call', async () => {
      const pipelineToolId = await createTool({
        name: 'refund-pipeline',
        type: 'pipeline',
        pipeline: {
          steps: [
            {
              id: 'step1',
              tool_id: refundToolId,
              input: { amount: { var: 'input.amount' } },
            },
          ],
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${pipelineToolId}/call`)
        .send({ input: { amount: 6 } });

      expect(response.status).toBe(200);
      expect(contextRequests).toEqual([
        refundCall({ amount: 6, currency: 'usd' }),
      ]);
    });
  });

  describe('POST /api/v1/orchestration-runs', () => {
    test('a tool node asks the context tool about the node call', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'guardctx-refund-run',
          project_id: projectId,
          nodes: [
            {
              id: 'act',
              type: 'tool',
              tool_id: refundToolId,
              input_mapping: { amount: { var: 'input.amount' } },
            },
          ],
          edges: [],
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { amount: 3 },
        });

      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(contextRequests).toEqual([refundCall({ amount: 3 })]);
    });
  });

  describe('POST /api/v1/guardrails/{guardrail_id}/evaluate', () => {
    test('the dry run asks the context tool as the real call would', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${guardrailId}/evaluate`)
        .send({ args: { amount: 9 }, tool_id: refundToolId });

      expect(response.status).toBe(200);
      expect(response.body.decision).toBe('execute');
      expect(response.body.context_source).toBe('tool');
      expect(contextRequests).toEqual([refundCall({ amount: 9 })]);
    });

    test('without a tool_id the call names no tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${guardrailId}/evaluate`)
        .send({ args: { amount: 9 } });

      expect(response.status).toBe(200);
      expect(contextRequests).toEqual([
        {
          call: {
            action: null,
            tool: { id: null, name: null },
            args: { amount: 9 },
          },
        },
      ]);
    });

    test('a builtin context tool with a preset action resolves context.*', async () => {
      const builtinContextToolId = await createTool({
        name: 'builtin-context',
        type: 'builtin',
        actions: ['get-tool'],
        preset_parameters: { action: 'get-tool', tool_id: refundToolId },
      });
      const builtinGuardrailId = await createGuardrail({
        name: 'guardctx-builtin',
        document: {
          class: 'B',
          guard: { '==': [{ var: 'context.name' }, 'refund'] },
        },
        context_tool_id: builtinContextToolId,
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${builtinGuardrailId}/evaluate`)
        .send({ args: { amount: 2 }, tool_id: refundToolId });

      expect(response.status).toBe(200);
      expect(response.body.context_snapshot['context.name']).toBe('refund');
      expect(response.body.decision).toBe('execute');
    });
  });
});
