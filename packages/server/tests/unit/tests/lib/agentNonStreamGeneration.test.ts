import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import { db } from 'src/db';
import type { PendingGeneration } from 'src/lib/agentGenerationHelpers';
import { buildModel } from 'src/lib/agentModel';
// Statically imported (real `ai`, real DB) for the stub-server test below;
// the doMock('ai') tests use the dynamic loadNonStreamModule instead.
import { runNonStreamGeneration as runNonStreamGenerationReal } from 'src/lib/agentNonStreamGeneration';

const loadNonStreamModule = async () => {
  return import('src/lib/agentNonStreamGeneration');
};

// Real project/agent so buildCompletedGenerationResult's awaited saveTrace
// (which looks up the agent by publicId) succeeds against the real DB — no
// mocking of the trace/generation helpers needed.
let realProjectId: number;
let realProjectPublicId: string;
let realAgentPublicId: string;

const buildTypedAgent = () => {
  return {
    instructions: 'sys',
    model: 'mock-model',
    toolIds: null,
    maxSteps: 3,
    toolChoice: 'auto',
    stopConditions: null,
    activeToolIds: null,
    stepRules: [{ step: 1, toolChoice: { type: 'tool', toolName: 'forced' } }],
    boundaryPolicy: null,
    temperature: null,
    project: { id: realProjectId, publicId: realProjectPublicId },
    aiProvider: { publicId: 'aip_test' },
  } as never;
};

describe('agentNonStreamGeneration', () => {
  beforeAll(async () => {
    const project = await db.Project.create({ name: 'NonStreamGen Lib Test' });
    realProjectId = project.id;
    realProjectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId: project.id,
      name: 'NonStream Provider',
      provider: 'ollama',
      defaultModel: 'mock-model',
    });

    const agent = await db.Agent.create({
      projectId: project.id,
      aiProviderId: aiProvider.id,
      name: 'NonStream Agent',
    });
    realAgentPublicId = agent.publicId;
  });

  afterEach(() => {
    jest.unmock('ai');
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('buildPrepareStep returns undefined when stepRules are empty', async () => {
    const { buildPrepareStep } = await loadNonStreamModule();
    const prepareStep = buildPrepareStep({
      stepRules: [],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeUndefined();
  });

  test('buildPrepareStep returns forced tool config for matching step', async () => {
    const { buildPrepareStep } = await loadNonStreamModule();
    const prepareStep = buildPrepareStep({
      stepRules: [
        { step: 2, toolChoice: { type: 'tool', toolName: 'lookup' } },
      ],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 1 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'lookup' },
      activeTools: ['lookup'],
    });
    expect(prepareStep!({ stepNumber: 0 })).toEqual({});
  });

  test('buildToolResultMessages maps string and object outputs', async () => {
    const { buildToolResultMessages } = await loadNonStreamModule();
    const messages = buildToolResultMessages({
      toolOutputs: [
        { toolCallId: 'tc_1', output: 'hello' },
        { toolCallId: 'tc_2', output: { ok: true } },
      ],
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'toolOne', args: {} },
        { toolCallId: 'tc_2', toolName: 'toolTwo', args: {} },
      ],
    });

    expect(messages[0].content[0].output.value).toBe('hello');
    expect(messages[1].content[0].output.value).toBe('{"ok":true}');
    expect(messages[1].content[0].toolName).toBe('toolTwo');
  });

  test('buildToolResultMessages applies a client tool output_mapping keyed by tool name', async () => {
    const { buildToolResultMessages } = await loadNonStreamModule();
    const messages = buildToolResultMessages({
      toolOutputs: [
        { toolCallId: 'tc_1', output: { text: 'Hi!', language: 'en' } },
      ],
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'transcribe', args: {} },
      ],
      outputMappingsByToolName: {
        transcribe: { var: 'output.text' },
      },
    });

    expect(messages[0].content[0].output.value).toBe('Hi!');
  });

  test('buildToolResultMessages leaves output unchanged for tools without an output_mapping', async () => {
    const { buildToolResultMessages } = await loadNonStreamModule();
    const messages = buildToolResultMessages({
      toolOutputs: [{ toolCallId: 'tc_1', output: { ok: true } }],
      pendingToolCalls: [{ toolCallId: 'tc_1', toolName: 'toolOne', args: {} }],
      outputMappingsByToolName: { otherTool: { var: 'output.text' } },
    });

    expect(messages[0].content[0].output.value).toBe('{"ok":true}');
  });

  test('runNonStreamGeneration returns requires_action result when pending client tools exist', async () => {
    // A client tool is a resolvedTool with no `execute`; the real
    // findPendingClientTools picks the returned tool call up and the real
    // savePendingGeneration produces the requires_action result — no helper
    // mocking, only the sanctioned `ai` stub controls the model output.
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockResolvedValue({
          steps: [
            {
              toolCalls: [
                { toolCallId: 'tc_1', toolName: 'client', input: {} },
              ],
            },
          ],
          response: { messages: [], modelId: 'model-a' },
          text: 'ignored',
          finishReason: 'tool-calls',
        }),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'hi' }],
      resolvedTools: { client: {} as Tool },
      typedAgent: buildTypedAgent(),
      generationId: 'gen_nonstream_ra',
      traceId: 'trc_nonstream_ra',
      agentId: realAgentPublicId,
    });

    expect(result.status).toBe('requires_action');
    expect(result.requiredAction?.toolCalls).toEqual([
      { id: 'tc_1', toolName: 'client', args: {} },
    ]);
  });

  test('runNonStreamGeneration throws when no-tools generation fails', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest
          .fn()
          .mockRejectedValue(new Error('provider unavailable')),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();

    await expect(
      runNonStreamGeneration({
        model: {} as never,
        allMessages: [{ role: 'user', content: 'hi' }],
        resolvedTools: {},
        typedAgent: buildTypedAgent(),
        generationId: 'gen_3',
        traceId: 'trc_3',
        agentId: 'agt_3',
      })
    ).rejects.toThrow('provider unavailable');
  });

  const buildPending = (
    overrides: Partial<PendingGeneration> = {}
  ): PendingGeneration => {
    return {
      agentId: 'agt_test',
      projectId: 1,
      projectPublicId: 'prj_test',
      traceId: 'trc_test',
      parentTraceId: null,
      rootTraceId: null,
      generationId: 'gen_test',
      initiatorGenerationId: null,
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'send-reply', args: { message: 'Hi' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      steps: [],
      resolvedModel: {} as never,
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
      resolvedTools: {
        'send-reply': { description: 'Send reply', inputSchema: {} } as never,
      },
      ...overrides,
    };
  };

  test('runToolOutputsGeneration + resolveToolOutputsResult reports requires_action for a continuation tool call', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockResolvedValue({
          text: 'I will send the reply.',
          finishReason: 'tool-calls',
          steps: [
            {
              toolCalls: [
                {
                  toolCallId: 'tc_new_1',
                  toolName: 'send-reply',
                  input: { message: 'Hello from bot' },
                },
              ],
            },
          ],
          response: { modelId: 'mock-model', messages: [] },
        }),
      };
    });

    const { runToolOutputsGeneration, resolveToolOutputsResult } =
      await loadNonStreamModule();

    const pending = buildPending();

    const generateResult = await runToolOutputsGeneration({
      generationId: pending.generationId,
      pending,
      system: undefined,
      nonSystemMessages: pending.messages,
    });

    const result = await resolveToolOutputsResult({
      generationId: pending.generationId,
      agentId: pending.agentId,
      pending,
      allMessages: pending.messages,
      result: generateResult as never,
    });

    expect(result).toMatchObject({
      id: pending.generationId,
      traceId: pending.traceId,
      status: 'requires_action',
      requiredAction: {
        type: 'submit_tool_outputs',
        toolCalls: [
          expect.objectContaining({
            toolName: 'send-reply',
            id: 'tc_new_1',
          }),
        ],
      },
    });
  });

  test('runToolOutputsGeneration + resolveToolOutputsResult reports completed when no client tool calls remain', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockResolvedValue({
          text: 'final answer',
          finishReason: 'stop',
          steps: [],
          response: { modelId: 'mock-model' },
        }),
      };
    });

    const { runToolOutputsGeneration, resolveToolOutputsResult } =
      await loadNonStreamModule();

    const pending = buildPending({ resolvedTools: {} });

    const generateResult = await runToolOutputsGeneration({
      generationId: pending.generationId,
      pending,
      system: undefined,
      nonSystemMessages: pending.messages,
    });

    const result = await resolveToolOutputsResult({
      generationId: pending.generationId,
      agentId: pending.agentId,
      pending,
      allMessages: pending.messages,
      result: generateResult as never,
    });

    expect(result).toMatchObject({
      id: pending.generationId,
      traceId: pending.traceId,
      status: 'completed',
      output: {
        model: 'mock-model',
        content: 'final answer',
        finishReason: 'stop',
      },
    });
  });

  // ── Client-tool guardrail gate wiring ────────────────────────────────────
  // Drives runNonStreamGeneration with a client tool carrying a CLIENT_TOOL_GATE
  // closure, mocking `ai.generateText` so the gate decision is deterministic.
  // CLIENT_TOOL_GATE is imported from the SAME freshly-loaded module graph as
  // runNonStreamGeneration (post doMock + resetModules) so the symbol matches.

  const gateTypedAgent = () => {
    return {
      instructions: null,
      model: 'mock-model',
      toolIds: null,
      maxSteps: 5,
      toolChoice: 'auto',
      stopConditions: null,
      activeToolIds: null,
      stepRules: null,
      boundaryPolicy: null,
      temperature: null,
      outputSchema: null,
      project: { id: realProjectId, publicId: realProjectPublicId },
      aiProvider: { publicId: 'aip_test' },
    } as never;
  };

  const clientCallResult = (toolCallId: string) => {
    return {
      text: '',
      finishReason: 'tool-calls',
      steps: [
        {
          toolCalls: [{ toolCallId, toolName: 'client-tool', input: { x: 1 } }],
        },
      ],
      response: {
        modelId: 'mock-model',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId,
                toolName: 'client-tool',
                input: { x: 1 },
              },
            ],
          },
        ],
      },
    };
  };

  test('a gated (blocked) client call is not released — the model resumes and completes', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      const generateText = jest
        .fn()
        .mockResolvedValueOnce(clientCallResult('tc_blocked'))
        .mockResolvedValueOnce({
          text: 'I could not do that.',
          finishReason: 'stop',
          steps: [],
          response: { modelId: 'mock-model', messages: [] },
        });
      return { ...actual, generateText };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const { CLIENT_TOOL_GATE } = await import('src/lib/agentToolGuardrail');

    const resolvedTools = {
      'client-tool': {
        description: 'c',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        [CLIENT_TOOL_GATE]: async () => {
          return {
            decision: 'blocked',
            cleanArgs: {},
            result: { status: 'blocked' },
          };
        },
      } as never,
    };

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'go' }],
      resolvedTools,
      typedAgent: gateTypedAgent(),
      generationId: 'gen_gate_blocked',
      traceId: 'trc_gate_blocked',
      agentId: realAgentPublicId,
    });

    expect(result.status).toBe('completed');
    expect(result.output?.content).toBe('I could not do that.');
  });

  test('a released (execute) client call suspends at requires_action', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest
          .fn()
          .mockResolvedValue(clientCallResult('tc_release')),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const { CLIENT_TOOL_GATE } = await import('src/lib/agentToolGuardrail');

    const resolvedTools = {
      'client-tool': {
        description: 'c',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        [CLIENT_TOOL_GATE]: async () => {
          return { decision: 'execute', cleanArgs: { x: 1 } };
        },
      } as never,
    };

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'go' }],
      resolvedTools,
      typedAgent: gateTypedAgent(),
      generationId: 'gen_gate_release',
      traceId: 'trc_gate_release',
      agentId: realAgentPublicId,
    });

    expect(result.status).toBe('requires_action');
    expect(result.requiredAction?.toolCalls[0].toolName).toBe('client-tool');
    expect(result.requiredAction?.toolCalls[0].args).toEqual({ x: 1 });
  });
});

// Exercises runNonStreamGeneration's real tool-failure fallback (the
// with-tools call fails, it retries without tools and completes) end-to-end:
// real `generateText` against a local OpenAI-compatible stub, real DB, real
// buildCompletedGenerationResult -> saveTrace. No `ai` mock and no
// resetModules here (both would sever the real DB), so this uses the
// statically-imported runNonStreamGeneration. This is the same local-fake-
// server pattern discussionCompletion.test.ts uses.
describe('runNonStreamGeneration tool-failure fallback (stub server)', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  let withToolsRequestCount = 0;
  let projectDbId: number;
  let projectPublicId: string;
  let agentPublicId: string;

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { tools?: unknown[] };
        // The first (with-tools) call fails; the no-tools retry succeeds.
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          withToolsRequestCount += 1;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'tool call failed' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fallback',
            object: 'chat.completion',
            created: 0,
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'fallback answer' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    const project = await db.Project.create({
      name: 'NonStream Fallback Project',
    });
    projectDbId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId: project.id,
      name: 'Fallback Provider',
      provider: 'ollama',
      defaultModel: 'mock-model',
      baseUrl: stubBaseUrl,
    });

    const agent = await db.Agent.create({
      projectId: project.id,
      aiProviderId: aiProvider.id,
      name: 'Fallback Agent',
    });
    agentPublicId = agent.publicId;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  test('falls back to a no-tools generation and completes when the tool call fails', async () => {
    const model = buildModel({
      provider: 'ollama',
      secretValue: null,
      model: 'mock-model',
      baseUrl: stubBaseUrl,
    });

    const result = await runNonStreamGenerationReal({
      model,
      allMessages: [{ role: 'user', content: 'hi' }],
      resolvedTools: {
        lookup: tool({
          description: 'A client tool with no execute',
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
        }) as Tool,
      },
      typedAgent: {
        instructions: null,
        model: 'mock-model',
        toolIds: null,
        maxSteps: 3,
        toolChoice: 'auto',
        stopConditions: null,
        activeToolIds: null,
        stepRules: null,
        boundaryPolicy: null,
        temperature: null,
        outputSchema: null,
        project: { id: projectDbId, publicId: projectPublicId },
        aiProvider: { publicId: 'aip_fallback' },
      } as never,
      generationId: 'gen_nonstream_fallback',
      traceId: 'trc_nonstream_fallback',
      agentId: agentPublicId,
    });

    expect(withToolsRequestCount).toBeGreaterThan(0);
    expect(result.status).toBe('completed');
    expect(result.output?.content).toBe('fallback answer');
  });
});
