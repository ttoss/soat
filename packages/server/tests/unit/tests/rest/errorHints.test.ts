import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `SOAT_OMIT_ERROR_HINTS` (`self-hosting/configuration.md`) holds on every
 * surface an error reaches, not only the REST body `errorBody` writes.
 */
// Either key, also inside a relayed body serialised as a JSON string.
const HINT_KEYS = /docs_url|\\*"hint\\*"/;

const withHintsOmitted = async <T>(
  omitted: boolean,
  run: () => Promise<T>
): Promise<T> => {
  const previous = process.env.SOAT_OMIT_ERROR_HINTS;
  if (omitted) process.env.SOAT_OMIT_ERROR_HINTS = 'true';
  else delete process.env.SOAT_OMIT_ERROR_HINTS;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SOAT_OMIT_ERROR_HINTS;
    else process.env.SOAT_OMIT_ERROR_HINTS = previous;
  }
};

beforeAll(() => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
});

afterAll(() => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
});

describe('SOAT_OMIT_ERROR_HINTS', () => {
  let adminToken: string;
  let projectId: string;
  let getAgentToolId: string;
  let modelServer: Server;
  let completionBodies: Record<string, unknown>[] = [];
  let generationAgentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'errorhints',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'errorhints-get-agent',
        type: 'builtin',
        actions: ['get-agent'],
      });
    expect(toolRes.status).toBe(201);
    getAgentToolId = toolRes.body.id;

    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        completionBodies.push(body);
        const answered = (body.messages as { role: string }[]).some((m) => {
          return m.role === 'tool';
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-errorhints',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: answered
                  ? { role: 'assistant', content: 'done' }
                  : {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_errorhints_1',
                          type: 'function',
                          function: {
                            name: 'errorhints-get-agent_get-agent',
                            arguments: JSON.stringify({
                              agent_id: 'agent_nonexistent',
                            }),
                          },
                        },
                      ],
                    },
                finish_reason: answered ? 'stop' : 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = modelServer.address() as AddressInfo;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'errorhints-stub-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: `http://127.0.0.1:${port}`,
      });
    expect(providerRes.status).toBe(201);

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'errorhints-agent',
        tool_bindings: [{ tool_id: getAgentToolId }],
      });
    expect(agentRes.status).toBe(201);
    generationAgentId = agentRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      modelServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  const restNotFound = () => {
    return authenticatedTestClient(adminToken).get(
      '/api/v1/agents/agent_nonexistent'
    );
  };

  const failedBuiltinCall = () => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${getAgentToolId}/call`)
      .send({ action: 'get-agent', input: { agent_id: 'agent_nonexistent' } });
  };

  const failedRunError = async () => {
    const orchestrationRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: `errorhints-run-${Date.now()}`,
        nodes: [
          {
            id: 'call',
            type: 'tool',
            tool_id: getAgentToolId,
            operation_id: 'get-agent',
            input_mapping: { agent_id: 'agent_nonexistent' },
          },
        ],
        edges: [],
      });
    expect(orchestrationRes.status).toBe(201);

    const startRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestration-runs')
      .send({ orchestration_id: orchestrationRes.body.id });
    expect(startRes.status).toBe(201);
    await drainQueueOnce();

    const run = await db.OrchestrationRun.findOne({
      where: { publicId: startRes.body.id },
    });
    expect(run!.status).toBe('failed');
    return run!.error as { code: string; meta?: Record<string, unknown> };
  };

  describe('unset', () => {
    test('a REST 404 carries hint and docs_url', async () => {
      const response = await withHintsOmitted(false, restNotFound);
      expect(response.status).toBe(404);
      expect(response.body.error.hint).toEqual(expect.any(String));
      expect(response.body.error.docs_url).toEqual(expect.any(String));
    });

    test('a failed builtin action relays a body carrying both', async () => {
      const response = await withHintsOmitted(false, failedBuiltinCall);
      expect(response.status).toBe(502);
      expect(response.body.error.hint).toEqual(expect.any(String));
      const relayed = JSON.parse(response.body.error.meta.tool_response_body);
      expect(relayed.error.hint).toEqual(expect.any(String));
      expect(relayed.error.docs_url).toEqual(expect.any(String));
    });

    test('a failed orchestration run stores the relayed body with both', async () => {
      const error = await withHintsOmitted(false, failedRunError);
      expect(error.code).toBe('TOOL_HTTP_ERROR');
      expect(JSON.stringify(error)).toMatch(HINT_KEYS);
    });
  });

  describe('true', () => {
    test('a REST 404 carries neither', async () => {
      const response = await withHintsOmitted(true, restNotFound);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(HINT_KEYS);
    });

    test('a failed builtin action carries neither, outside or relayed', async () => {
      const response = await withHintsOmitted(true, failedBuiltinCall);
      expect(response.status).toBe(502);
      expect(response.body.error.meta.tool_status_code).toBe(404);
      expect(JSON.stringify(response.body)).not.toMatch(HINT_KEYS);
    });

    test('a failed builtin action inside a generation reaches neither the model nor the caller', async () => {
      completionBodies = [];
      const response = await withHintsOmitted(true, () => {
        return authenticatedTestClient(adminToken)
          .post(`/api/v1/agents/${generationAgentId}/generate?wait=true`)
          .send({ messages: [{ role: 'user', content: 'Use your tool.' }] });
      });
      expect(response.status).toBe(200);
      expect(completionBodies.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(completionBodies)).not.toMatch(HINT_KEYS);
      expect(JSON.stringify(response.body)).not.toMatch(HINT_KEYS);
    });

    test('a failed orchestration run stores neither', async () => {
      const error = await withHintsOmitted(true, failedRunError);
      expect(error.code).toBe('TOOL_HTTP_ERROR');
      expect(JSON.stringify(error)).not.toMatch(HINT_KEYS);
    });
  });
});
