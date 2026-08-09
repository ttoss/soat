import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { jsonSchema, tool } from 'ai';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { pendingGenerations } from 'src/lib/agentGenerationHelpers';
import type { PendingGeneration } from 'src/lib/agentGenerationTypes';
import { buildModel } from 'src/lib/agentModel';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

describe('Agent Generation Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('POST /api/v1/agents/:id/generate returns 401 when unauthenticated', async () => {
    const response = await testClient
      .post('/api/v1/agents/agent_test_id/generate')
      .send({ messages: [{ role: 'user', content: 'hello' }] });

    expect(response.status).toBe(401);
  });

  test('POST /api/v1/agents/:id/generate/:gen_id/tool-outputs returns 401 when unauthenticated', async () => {
    const response = await testClient
      .post('/api/v1/agents/agent_test_id/generate/gen_test_id/tool-outputs')
      .send({
        tool_outputs: [{ tool_call_id: 'tc_1', output: 'result' }],
      });

    expect(response.status).toBe(401);
  });

  describe('ai_provider_not_found branch', () => {
    let adminToken: string;
    let userToken: string;
    let agentId: string;

    beforeAll(async () => {
      await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'agentgeneradmin', password: 'supersecret' });
      adminToken = await loginAs('agentgeneradmin', 'supersecret');

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentgeneruser', password: 'agentgenerpass' });
      userToken = await loginAs('agentgeneruser', 'agentgenerpass');
      const userId = userRes.body.id;

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'AgentGeneration Test Project' });
      const projectId = projectRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['agents:CreateAgent', 'agents:CreateAgentGeneration'],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Gen Test Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProvRes.body.id,
          project_id: projectId,
          name: 'Gen Test Agent',
        });
      agentId = agentRes.body.id;
    });

    test('returns 400 when ai provider is not found', async () => {
      mockCreateGeneration.mockRejectedValueOnce(
        new DomainError('AI_PROVIDER_NOT_FOUND', 'AI provider not found')
      );
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('validation and error branches', () => {
    let adminToken: string;
    let userToken: string;
    let noPermToken: string;
    let agentId: string;

    beforeAll(async () => {
      const bootstrapRes = await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'agentvalidadmin', password: 'supersecret' });

      // Bootstrap can run only once in the test DB. If it already ran in
      // another describe, reuse that admin account for setup.
      if (bootstrapRes.status === 201) {
        adminToken = await loginAs('agentvalidadmin', 'supersecret');
      } else {
        adminToken = await loginAs('agentgeneradmin', 'supersecret');
      }

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentvaliduser', password: 'agentvalidpass' });
      userToken = await loginAs('agentvaliduser', 'agentvalidpass');

      await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentvalidnoperm', password: 'agentnopass' });
      noPermToken = await loginAs('agentvalidnoperm', 'agentnopass');

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'AgentGeneration Validation Project' });
      const projectId = projectRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['agents:CreateAgent', 'agents:CreateAgentGeneration'],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userRes.body.id}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Validation Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProvRes.body.id,
          project_id: projectId,
          name: 'Validation Agent',
        });
      agentId = agentRes.body.id;
    });

    test('returns 400 when messages is missing or empty', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [] });

      expect(response.status).toBe(400);
    });

    test('returns 404 when user cannot access target agent', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(404);
    });

    test('depth guard: returns 404 when the agent is not accessible at max_call_depth 0', async () => {
      // Exercises the depth-guard branch's own agent lookup/not-found throw,
      // a separate code path from the normal (non-depth-guard) not-found
      // case covered above.
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          max_call_depth: 0,
        });

      expect(response.status).toBe(404);
    });

    test('returns 500 when createGeneration throws', async () => {
      mockCreateGeneration.mockRejectedValueOnce(new Error('boom'));

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });

    test('tool-outputs returns 400 when payload is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_x/tool-outputs`)
        .send({ tool_outputs: [] });

      expect(response.status).toBe(400);
    });

    test('tool-outputs returns 404 for a generation that was never created', async () => {
      // No mocking here — exercises submitToolOutputs' real not-found path:
      // not in the in-memory pendingGenerations map and not recoverable
      // from the DB because it never existed.
      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/generate/gen_never_existed/tool-outputs`
        )
        .send({ tool_outputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('GENERATION_NOT_FOUND');
    });

    test('returns 200 with generation result on non-stream success', async () => {
      const mockResult = {
        id: 'gen_success',
        traceId: 'trc_success',
        status: 'completed',
        output: { model: 'test', content: 'hi', finishReason: 'stop' },
      };
      mockCreateGeneration.mockResolvedValueOnce(mockResult as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('gen_success');
    });

    test('accepts tool_output message content in snake_case request body', async () => {
      const mockResult = {
        id: 'gen_tool_output',
        traceId: 'trc_tool_output',
        status: 'completed' as const,
        output: { model: 'test', content: 'resolved', finishReason: 'stop' },
      };
      mockCreateGeneration.mockResolvedValueOnce(mockResult);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [
            {
              role: 'user',
              content: {
                type: 'tool_output',
                tool_id: 'tool_audio_to_text',
                input: { url: 'https://example.com/audio.mp3' },
                output_path: 'text',
              },
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: {
                type: 'tool_output',
                tool_id: 'tool_audio_to_text',
                input: { url: 'https://example.com/audio.mp3' },
                output_path: 'text',
              },
            },
          ],
        })
      );
    });

    test('accepts document content message in snake_case request body', async () => {
      const mockResult = {
        id: 'gen_document_input',
        traceId: 'trc_document_input',
        status: 'completed' as const,
        output: { model: 'test', content: 'resolved', finishReason: 'stop' },
      };
      mockCreateGeneration.mockResolvedValueOnce(mockResult);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [
            {
              role: 'user',
              content: { type: 'document', document_id: 'doc_abc123' },
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: { type: 'document', document_id: 'doc_abc123' },
            },
          ],
        })
      );
    });

    test('returns 400 when generate throws AGENT_NOT_FOUND', async () => {
      mockCreateGeneration.mockRejectedValueOnce(
        new DomainError('AGENT_NOT_FOUND', 'Agent not found')
      );

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('returns SSE stream when stream:true and result is a ReadableStream', async () => {
      const chunks = ['hello ', 'world'];
      let chunkIndex = 0;

      const readable = new ReadableStream<string>({
        pull: (controller) => {
          if (chunkIndex < chunks.length) {
            controller.enqueue(chunks[chunkIndex++]);
          } else {
            controller.close();
          }
        },
      });

      mockCreateGeneration.mockResolvedValueOnce(readable as ReadableStream);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }], stream: true });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('[DONE]');
    });

    test('SSE stream includes error event when ReadableStream errors', async () => {
      const errorStream = new ReadableStream<string>({
        start: (controller) => {
          controller.error(new Error('stream read error'));
        },
      });

      mockCreateGeneration.mockResolvedValueOnce(errorStream as ReadableStream);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }], stream: true });

      expect(response.status).toBe(200);
      expect(response.text).toContain('stream read error');
    });

    test('depth guard: returns completed with depth-guard message when max_call_depth is 0', async () => {
      // Do NOT queue a mock — let the real createGeneration run so the
      // depth-guard branch (with agent resolution) is exercised.
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          max_call_depth: 0,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
      expect(response.body.output.content).toBe('Maximum call depth reached');
      expect(response.body.output.finish_reason).toBe('stop');
      expect(response.body.trace_id).toBeDefined();
    });
  });

  describe('tool-outputs real continuation (local stub server)', () => {
    // Exercises submitToolOutputs' real body end-to-end (message building,
    // runToolOutputsGeneration, resolveToolOutputsResult) without mocking
    // db/eventBus/generations or the `ai` package. A local HTTP server
    // stands in for the AI provider — the same pattern used by
    // discussionCompletion.test.ts — so the real `ai.generateText` call
    // goes over real HTTP to a server we control instead of a live LLM.
    let stubServer: Server;
    let stubBaseUrl: string;
    let userToken: string;
    let agentId: string;
    let pausingAgentId: string;
    let aiProviderId: string;
    let showDialogToolId: string;
    let projectDbId: number;
    let projectPublicId: string;

    // When set, the stub answers the next completion with this tool call
    // instead of text, so a generation can be made to pause on a client tool.
    let nextToolCall: { name: string; args: unknown } | undefined;

    // When set, replaces the assistant text every completion returns — used to
    // reproduce a model that writes a tool call out instead of making one.
    let nextContent: string | undefined;

    const stubBody = () => {
      const toolCall = nextToolCall;
      nextToolCall = undefined;

      const message = toolCall
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_stub_1',
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              },
            ],
          }
        : { role: 'assistant', content: nextContent ?? 'final answer' };

      return {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message,
            finish_reason: toolCall ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };

    const startStubServer = async (): Promise<string> => {
      stubServer = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stubBody()));
      });
      await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = stubServer.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    };

    beforeAll(async () => {
      stubBaseUrl = await startStubServer();

      const bootstrapRes = await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'agentstubadmin', password: 'supersecret' });
      const adminToken =
        bootstrapRes.status === 201
          ? await loginAs('agentstubadmin', 'supersecret')
          : await loginAs('agentgeneradmin', 'supersecret');

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentstubuser', password: 'agentstubpass' });
      userToken = await loginAs('agentstubuser', 'agentstubpass');

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  'agents:CreateAgent',
                  'agents:CreateAgentGeneration',
                  'generations:GetGeneration',
                  'tools:CreateTool',
                  'usage:ListUsageMeters',
                  'usage:GetReceipt',
                ],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userRes.body.id}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'AgentGeneration Stub Project' });
      projectPublicId = projectRes.body.id;

      const project = await db.Project.findOne({
        where: { publicId: projectPublicId },
      });
      projectDbId = project!.id;

      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectPublicId,
          name: 'Stub Provider',
          provider: 'ollama',
          default_model: 'stub-model',
          base_url: stubBaseUrl,
        });

      aiProviderId = aiProvRes.body.id;

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProvRes.body.id,
          project_id: projectPublicId,
          name: 'Stub Agent',
        });
      agentId = agentRes.body.id;

      // A client tool pauses the generation with `requires_action` instead of
      // executing server-side, which is the path that persists pending state.
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectPublicId,
          name: 'show_dialog',
          type: 'client',
          description: 'Displays a confirmation dialog to the user',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
        });

      showDialogToolId = toolRes.body.id;

      const pausingAgentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProvRes.body.id,
          project_id: projectPublicId,
          name: 'Stub Pausing Agent',
          tool_ids: [toolRes.body.id],
        });
      pausingAgentId = pausingAgentRes.body.id;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        stubServer.close((err) => {
          return err ? reject(err) : resolve();
        });
      });
    });

    test('tool-outputs returns completed for a real pending generation', async () => {
      const pending: PendingGeneration = {
        agentId,
        projectId: projectDbId,
        projectPublicId,
        traceId: 'trc_stub_test',
        parentTraceId: null,
        rootTraceId: null,
        generationId: 'gen_stub_pending',
        initiatorGenerationId: null,
        pendingToolCalls: [{ toolCallId: 'tc_1', toolName: 'noop', args: {} }],
        messages: [{ role: 'user', content: 'hello' }],
        steps: [],
        resolvedModel: buildModel({
          provider: 'ollama',
          secretValue: null,
          model: 'stub-model',
          baseUrl: stubBaseUrl,
        }),
        agentConfig: {
          instructions: null,
          maxSteps: 5,
          toolChoice: 'auto',
          stopConditions: null,
          activeToolIds: null,
          stepRules: null,
          temperature: null,
          outputSchema: null,
        },
        resolvedTools: {},
      };
      pendingGenerations.set('gen_stub_pending', pending);

      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/generate/gen_stub_pending/tool-outputs`
        )
        .send({ tool_outputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('gen_stub_pending');
      expect(response.body.status).toBe('completed');
      expect(response.body.output.content).toBe('final answer');
      expect(pendingGenerations.has('gen_stub_pending')).toBe(false);
    });

    // Regression: pausing on a client tool used to persist recovery state by
    // *replacing* the generation's metadata bag (`metadata: { pendingState }`),
    // which is where usage attribution lived. Every generation that paused lost
    // its action/trigger/run/node attribution and all caller metadata, so its
    // usage event was billed unattributed. Attribution is a column now, so the
    // pending-state write cannot reach it.
    test('a generation that pauses on a client tool keeps its usage attribution', async () => {
      nextToolCall = { name: 'show_dialog', args: { message: 'confirm?' } };

      const paused = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${pausingAgentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'ask me' }],
          action_id: 'act_pause_probe',
          metadata: { ticket_id: 'OPS-9001' },
        });

      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('requires_action');

      // `buildRequiresActionGenerationResult` persists `requires_action`
      // fire-and-forget, so the record can still read `in_progress` for a moment
      // after the response returns — the generation lifecycle is poll-based by
      // design. Poll a bounded predicate rather than reading once: a single read
      // passes on a fast machine and fails under CI load, which is how this went
      // red on one shard while passing everywhere else.
      let record = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${paused.body.id}`
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (record.body.status === 'requires_action') break;
        await new Promise((resolve) => {
          return setTimeout(resolve, 50);
        });
        record = await authenticatedTestClient(userToken).get(
          `/api/v1/generations/${paused.body.id}`
        );
      }

      expect(record.status).toBe(200);
      expect(record.body.status).toBe('requires_action');
      expect(record.body.action_id).toBe('act_pause_probe');
      expect(record.body.metadata).toEqual({ ticket_id: 'OPS-9001' });
      // The persisted recovery state is not reachable through the API.
      expect(record.body.pending_state).toBeUndefined();
    }, 60000);

    test('tool-outputs recovers a pending generation from the DB when not in memory', async () => {
      // Simulates a server restart: no pendingGenerations map entry exists,
      // so submitToolOutputs must fall back to recoverPendingFromDb, which
      // rebuilds the pending state from the generation record's
      // `pendingState` column — real DB, real aiProviders/agentModel
      // resolution, no mocking.
      await createGenerationRecord({
        publicId: 'gen_recovered',
        projectId: projectDbId,
        agentId,
        traceId: 'trc_recovered',
      });
      await updateGenerationRecord({
        publicId: 'gen_recovered',
        pendingState: {
          pendingToolCalls: [
            { toolCallId: 'tc_1', toolName: 'noop', args: {} },
          ],
          messages: [{ role: 'user', content: 'hello' }],
          steps: [],
          parentTraceId: null,
          rootTraceId: null,
          toolContext: null,
          remainingDepth: null,
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_recovered/tool-outputs`)
        .send({ tool_outputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('gen_recovered');
      expect(response.body.status).toBe('completed');
      expect(response.body.output.content).toBe('final answer');
    });

    // The tool-outputs continuation completes the generation via
    // `resolveToolOutputsResult` -> `fireCompletionSideEffects`, a different
    // code path than the direct (no-pending-tool) completion in
    // `buildCompletedGenerationResult`. Only the latter called
    // `recordGenerationUsage`, so any generation that pauses for a client
    // tool call never got a usage event, even though the stub server
    // above returns real `usage` on every response.
    test('tool-outputs continuation records usage — meters and receipt reflect it', async () => {
      await createGenerationRecord({
        publicId: 'gen_usage_metered',
        projectId: projectDbId,
        agentId,
        traceId: 'trc_usage_metered',
      });
      await updateGenerationRecord({
        publicId: 'gen_usage_metered',
        pendingState: {
          pendingToolCalls: [
            { toolCallId: 'tc_1', toolName: 'noop', args: {} },
          ],
          messages: [{ role: 'user', content: 'hello' }],
          steps: [],
          parentTraceId: null,
          rootTraceId: null,
          toolContext: null,
          remainingDepth: null,
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/generate/gen_usage_metered/tool-outputs`
        )
        .send({ tool_outputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');

      // The tool-outputs continuation completes via a fire-and-forget side
      // effect (`fireCompletionSideEffects`, not awaited by the response), so
      // the usage event lands asynchronously — poll for it within a bound
      // instead of asserting immediately after the response returns.
      let metersRes = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters?generation_id=gen_usage_metered'
      );
      const startedAt = Date.now();
      while (metersRes.body.total === 0 && Date.now() - startedAt < 5000) {
        await sleep(50);
        metersRes = await authenticatedTestClient(userToken).get(
          '/api/v1/usage/meters?generation_id=gen_usage_metered'
        );
      }
      expect(metersRes.status).toBe(200);
      expect(metersRes.body.total).toBe(1);
      const components: Array<{ component: string; quantity: number }> =
        metersRes.body.data[0].components;
      const quantityOf = (name: string) => {
        return components.find((c) => {
          return c.component === name;
        })?.quantity;
      };
      expect(quantityOf('input_tokens')).toBe(1);
      expect(quantityOf('output_tokens')).toBe(1);

      const receiptRes = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/receipt?generation_id=gen_usage_metered'
      );
      expect(receiptRes.status).toBe(200);
      expect(receiptRes.body.line_items).toHaveLength(1);
      expect(receiptRes.body.total_input_tokens).toBe(1);
      expect(receiptRes.body.total_output_tokens).toBe(1);
    });

    // A model that writes its tool invocation out as assistant text instead of
    // making a structured call used to be indistinguishable from a real
    // answer: `finish_reason: stop`, one step, `status: completed`,
    // `error: null`, and the JSON blob as `output.content` — with the tool
    // never executed. Downstream consumers ran on the blob as if it were the
    // agent's work, and nothing anywhere said otherwise.
    describe('a tool call written out as text', () => {
      const blob =
        '```json\n{"name": "show_dialog", "arguments": {"message": "hi"}}\n```';

      afterEach(() => {
        nextContent = undefined;
      });

      test('fails the generation instead of completing it', async () => {
        nextContent = blob;

        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${pausingAgentId}/generate`)
          .send({ messages: [{ role: 'user', content: 'write a theme' }] });

        expect(response.status).toBe(502);
        expect(response.body.error.code).toBe('TEXT_ENCODED_TOOL_CALL');
        expect(response.body.error.meta.tool_name).toBe('show_dialog');

        const generationId: string = response.body.error.meta.generation_id;
        const generation = await db.Generation.findOne({
          where: { publicId: generationId },
        });
        expect(generation?.status).toBe('failed');
        expect(generation?.stopReason).toBe('error');
        expect(generation?.error).toMatchObject({
          code: 'TEXT_ENCODED_TOOL_CALL',
        });
      });

      test('keeps the offending step on the trace', async () => {
        // The text is the whole evidence for this failure; a trace without it
        // leaves nothing to diagnose from.
        nextContent = blob;

        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${pausingAgentId}/generate`)
          .send({ messages: [{ role: 'user', content: 'write a theme' }] });

        const trace = await db.Trace.findOne({
          where: { publicId: response.body.error.meta.trace_id },
        });
        expect(trace?.stepCount).toBe(1);
        expect(trace?.error).toMatchObject({
          code: 'TEXT_ENCODED_TOOL_CALL',
        });
      });

      test('an ordinary answer from the same tool-bound agent still completes', async () => {
        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${pausingAgentId}/generate`)
          .send({ messages: [{ role: 'user', content: 'write a theme' }] });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('completed');
        expect(response.body.output.content).toBe('final answer');
      });

      test('an agent with no tools bound is left alone', async () => {
        // Nothing to have called, so the blob is just text the model wrote.
        nextContent = blob;

        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/generate`)
          .send({ messages: [{ role: 'user', content: 'write a theme' }] });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('completed');
        expect(response.body.output.content).toBe(blob);
      });

      test('an agent with an output_schema is left to the schema validator', async () => {
        // With a schema, `content` is the serialized object — text this
        // detector has no business second-guessing. A schema whose own shape
        // happens to look like a tool call must still complete.
        const schemaAgentRes = await authenticatedTestClient(userToken)
          .post('/api/v1/agents')
          .send({
            ai_provider_id: aiProviderId,
            project_id: projectPublicId,
            name: 'Stub Schema Agent',
            tool_ids: [showDialogToolId],
            output_schema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
          });
        nextContent = JSON.stringify({ name: 'show_dialog' });

        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${schemaAgentRes.body.id}/generate`)
          .send({ messages: [{ role: 'user', content: 'write a theme' }] });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('completed');
        expect(response.body.output.object).toEqual({ name: 'show_dialog' });
      });

      // The continuation is a separate completion path — it does not go
      // through `buildCompletedGenerationResult` — and it ends on model text
      // just the same.
      test('the tool-outputs continuation fails on it too', async () => {
        nextContent = blob;

        const pending: PendingGeneration = {
          agentId: pausingAgentId,
          projectId: projectDbId,
          projectPublicId,
          traceId: 'trc_text_encoded_continuation',
          parentTraceId: null,
          rootTraceId: null,
          generationId: 'gen_text_encoded_continuation',
          initiatorGenerationId: null,
          pendingToolCalls: [
            { toolCallId: 'tc_1', toolName: 'show_dialog', args: {} },
          ],
          messages: [{ role: 'user', content: 'hello' }],
          steps: [],
          resolvedModel: buildModel({
            provider: 'ollama',
            secretValue: null,
            model: 'stub-model',
            baseUrl: stubBaseUrl,
          }),
          agentConfig: {
            instructions: null,
            maxSteps: 5,
            toolChoice: 'auto',
            stopConditions: null,
            activeToolIds: null,
            stepRules: null,
            temperature: null,
            outputSchema: null,
          },
          // A client tool: bound to the turn, with no `execute` of its own.
          resolvedTools: {
            show_dialog: tool({
              description: 'Displays a confirmation dialog to the user',
              inputSchema: jsonSchema({
                type: 'object',
                properties: { message: { type: 'string' } },
              }),
            }),
          },
        };
        await createGenerationRecord({
          publicId: 'gen_text_encoded_continuation',
          projectId: projectDbId,
          agentId: pausingAgentId,
          traceId: 'trc_text_encoded_continuation',
        });
        pendingGenerations.set('gen_text_encoded_continuation', pending);

        const response = await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${pausingAgentId}/generate/gen_text_encoded_continuation/tool-outputs`
          )
          .send({ tool_outputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

        expect(response.status).toBe(502);
        expect(response.body.error.code).toBe('TEXT_ENCODED_TOOL_CALL');

        const generation = await db.Generation.findOne({
          where: { publicId: 'gen_text_encoded_continuation' },
        });
        expect(generation?.status).toBe('failed');
      });
    });
  });
});
