import * as fs from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { db } from 'src/db';
import { initErrorHintOverrides, resolutionFor } from 'src/errors';
import { initDeploymentRegistrations } from 'src/lib/deploymentRegistrations';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `SOAT_OMIT_ERROR_HINTS` and `SOAT_OMIT_ERROR_DOCS_URL`
 * (`self-hosting/configuration.md`) hold on every surface an error reaches,
 * not only the REST body `errorBody` writes.
 */
// Either key, also inside a relayed body serialised as a JSON string.
const HINT_KEYS = /docs_url|\\*"hint\\*"/;

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const snapshotEnv = (vars: Record<string, string | undefined>) => {
  return Object.fromEntries(
    Object.keys(vars).map((name) => {
      return [name, process.env[name]];
    })
  );
};

const withEnv = async <T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> => {
  const previous = snapshotEnv(vars);
  applyEnv(vars);
  try {
    return await run();
  } finally {
    applyEnv(previous);
  }
};

const withEnvSync = (
  vars: Record<string, string | undefined>,
  run: () => void
): void => {
  const previous = snapshotEnv(vars);
  applyEnv(vars);
  try {
    run();
  } finally {
    applyEnv(previous);
  }
};

const withHintsOmitted = <T>(
  omitted: boolean,
  run: () => Promise<T>
): Promise<T> => {
  const value = omitted ? 'true' : undefined;
  return withEnv(
    { SOAT_OMIT_ERROR_HINTS: value, SOAT_OMIT_ERROR_DOCS_URL: value },
    run
  );
};

beforeAll(() => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
});

afterAll(() => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
});

describe('error hints', () => {
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

  describe('both settings unset', () => {
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
      const relayed = response.body.error.meta.tool_error;
      expect(relayed.hint).toEqual(expect.any(String));
      expect(relayed.docs_url).toEqual(expect.any(String));
    });

    test('a failed orchestration run stores the relayed body with both', async () => {
      const error = await withHintsOmitted(false, failedRunError);
      expect(error.code).toBe('TOOL_HTTP_ERROR');
      expect(JSON.stringify(error)).toMatch(HINT_KEYS);
    });
  });

  describe('both settings true', () => {
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

  describe('each alone', () => {
    test('SOAT_OMIT_ERROR_DOCS_URL keeps hint', async () => {
      const response = await withEnv(
        { SOAT_OMIT_ERROR_HINTS: undefined, SOAT_OMIT_ERROR_DOCS_URL: 'true' },
        restNotFound
      );
      expect(response.status).toBe(404);
      expect(response.body.error.hint).toBe(
        resolutionFor({ code: 'RESOURCE_NOT_FOUND' })
      );
      expect(response.body.error.docs_url).toBeUndefined();
    });

    test('SOAT_OMIT_ERROR_HINTS keeps docs_url', async () => {
      const response = await withEnv(
        { SOAT_OMIT_ERROR_HINTS: 'true', SOAT_OMIT_ERROR_DOCS_URL: undefined },
        restNotFound
      );
      expect(response.status).toBe(404);
      expect(response.body.error.hint).toBeUndefined();
      expect(response.body.error.docs_url).toEqual(expect.any(String));
    });
  });

  describe('SOAT_ROUTE_PREFIX', () => {
    test('a hint names the route under the deployment prefix', async () => {
      const response = await withEnv(
        { SOAT_ROUTE_PREFIX: '/v1/projects/{project_id}' },
        () => {
          return authenticatedTestClient('not-a-token').get('/api/v1/agents');
        }
      );
      expect(response.status).toBe(401);
      expect(response.body.error.hint).toContain(
        '`POST /v1/projects/{project_id}/users/login`'
      );
      expect(response.body.error.hint).not.toContain('/api/v1/');
    });

    test('unset, a hint names the route under /api/v1', async () => {
      const response = await withEnv({ SOAT_ROUTE_PREFIX: undefined }, () => {
        return authenticatedTestClient('not-a-token').get('/api/v1/agents');
      });
      expect(response.status).toBe(401);
      expect(response.body.error.hint).toContain('`POST /api/v1/users/login`');
    });
  });

  describe('SOAT_OPENAPI_DOCUMENT_PATH', () => {
    const unknownField = () => {
      return authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, not_a_field: true });
    };

    test('a fallback hint names the document at the path set', async () => {
      const response = await withEnv(
        {
          SOAT_OPENAPI_DOCUMENT_PATH: '/v1/openapi.json',
          SOAT_ROUTE_PREFIX: '/v1/projects/{project_id}',
        },
        unknownField
      );
      expect(response.status).toBe(400);
      expect(response.body.error.hint).toContain('`/v1/openapi.json`');
    });

    test('unset, a fallback hint names /api/v1/openapi.json', async () => {
      const response = await withEnv(
        { SOAT_OPENAPI_DOCUMENT_PATH: undefined },
        unknownField
      );
      expect(response.status).toBe(400);
      expect(response.body.error.hint).toContain('`/api/v1/openapi.json`');
    });
  });

  describe('SOAT_ERROR_HINTS_CONFIG', () => {
    let dir: string;

    const writeConfig = (config: unknown): string => {
      const file = path.join(dir, `hints-${Date.now()}-${Math.random()}.json`);
      fs.writeFileSync(file, JSON.stringify(config));
      return file;
    };

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-hints-'));
    });

    afterEach(() => {
      initErrorHintOverrides({ env: {} });
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test("an override replaces the code's hint, routes rendered", async () => {
      initErrorHintOverrides({
        env: {
          SOAT_ERROR_HINTS_CONFIG: writeConfig({
            hints: { RESOURCE_NOT_FOUND: 'List them with `{{GET /agents}}`.' },
          }),
        },
      });
      const response = await withEnv(
        { SOAT_ROUTE_PREFIX: '/v1/projects/{project_id}' },
        () => {
          return authenticatedTestClient(adminToken).get(
            '/api/v1/agents/agent_nonexistent'
          );
        }
      );
      expect(response.status).toBe(404);
      expect(response.body.error.hint).toBe(
        'List them with `GET /v1/projects/{project_id}/agents`.'
      );
    });

    test('omit_meta leaves the named keys out of a REST error', async () => {
      const providerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: `errorhints-omit-${Date.now()}`,
          provider: 'ollama',
          default_model: 'stub-model',
        });
      expect(providerRes.status).toBe(201);
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, ai_provider_id: providerRes.body.id });
      expect(agentRes.status).toBe(201);
      initErrorHintOverrides({
        env: {
          SOAT_ERROR_HINTS_CONFIG: writeConfig({
            omit_meta: {
              AI_PROVIDER_HAS_DEPENDENTS: ['chat_count', 'chat_ids'],
            },
          }),
        },
      });

      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/ai-providers/${providerRes.body.id}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AI_PROVIDER_HAS_DEPENDENTS');
      expect(response.body.error.meta.chat_count).toBeUndefined();
      expect(response.body.error.meta.chat_ids).toBeUndefined();
      expect(response.body.error.meta.agent_count).toBe(1);
    });

    test('omit_meta leaves the named keys out of a stored error', async () => {
      initErrorHintOverrides({
        env: {
          SOAT_ERROR_HINTS_CONFIG: writeConfig({
            omit_meta: { TOOL_HTTP_ERROR: ['tool_error'] },
          }),
        },
      });

      const error = await failedRunError();

      expect(error.code).toBe('TOOL_HTTP_ERROR');
      expect(error.meta?.tool_error).toBeUndefined();
    });

    test('an override naming a code the runtime does not define fails boot', () => {
      expect(() => {
        return withEnvSync(
          {
            SOAT_ERROR_HINTS_CONFIG: writeConfig({
              hints: { NOT_A_RUNTIME_CODE: 'Anything.' },
            }),
          },
          initDeploymentRegistrations
        );
      }).toThrow(/NOT_A_RUNTIME_CODE.*does not define/);
    });

    test.each([
      ['not an object', []],
      ['an unknown top-level key', { hints: {}, extra: true }],
      ['hints not an object', { hints: 'x' }],
      ['an empty hint', { hints: { RESOURCE_NOT_FOUND: ' ' } }],
      ['omit_meta not an object', { omit_meta: [] }],
      ['omit_meta naming an unknown code', { omit_meta: { NOPE: ['a'] } }],
      ['omit_meta keys not a list', { omit_meta: { FORBIDDEN: 'action' } }],
      ['omit_meta with no keys', { omit_meta: { FORBIDDEN: [] } }],
    ])('a config with %s fails boot', (_label, config) => {
      expect(() => {
        return initErrorHintOverrides({
          env: { SOAT_ERROR_HINTS_CONFIG: writeConfig(config) },
        });
      }).toThrow(/Error hints config/);
    });

    test('an unreadable config fails boot', () => {
      expect(() => {
        return initErrorHintOverrides({
          env: { SOAT_ERROR_HINTS_CONFIG: path.join(dir, 'missing.json') },
        });
      }).toThrow(/Could not load error hints config/);
    });
  });
});
