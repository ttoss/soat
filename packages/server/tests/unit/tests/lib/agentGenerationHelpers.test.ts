import {
  buildAllMessages,
  buildCompletedGenerationResult,
  findPendingClientTools,
  pendingGenerations,
  runStreamGeneration,
  savePendingGeneration,
  type TypedAgent,
} from 'src/lib/agentGenerationHelpers';
import { buildDepthGuardResult } from 'src/lib/agentGenerationRecovery';
import * as generationsModule from 'src/lib/generations';
import * as tracesModule from 'src/lib/traces';

describe('buildAllMessages', () => {
  test('returns messages unchanged when instructions is null', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = buildAllMessages(null, messages);
    expect(result).toEqual(messages);
  });

  test('returns messages unchanged when instructions is empty string', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = buildAllMessages('', messages);
    expect(result).toEqual(messages);
  });

  test('prepends system message when instructions is provided', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = buildAllMessages('You are a helpful assistant', messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant',
    });
    expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  test('handles empty messages array', () => {
    const result = buildAllMessages('Instructions', []);
    expect(result).toEqual([{ role: 'system', content: 'Instructions' }]);
  });

  test('handles multiple messages', () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ];
    const result = buildAllMessages('Be helpful', messages);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('system');
  });
});

describe('buildDepthGuardResult', () => {
  test('returns a completed generation result with depth guard message', () => {
    const result = buildDepthGuardResult({
      traceId: 'trace-123',
      projectId: 1,
      projectPublicId: 'proj_test',
      agentId: 'agent-abc',
      generationId: 'gen_test123',
    });

    expect(result.status).toBe('completed');
    expect(result.traceId).toBe('trace-123');
    expect(result.id).toBe('gen_test123');
    expect(result.output).toBeDefined();
    expect(result.output?.content).toBe('Maximum call depth reached');
    expect(result.output?.finishReason).toBe('stop');
  });
});

describe('findPendingClientTools', () => {
  test('returns empty array when steps have no tool calls', () => {
    const result = findPendingClientTools([{}, {}], {});
    expect(result).toEqual([]);
  });

  test('returns empty array when no tools match resolvedTools', () => {
    const steps = [
      {
        toolCalls: [{ toolCallId: 'tc1', toolName: 'myTool', input: {} }],
      },
    ];
    const result = findPendingClientTools(steps, {});
    expect(result).toEqual([]);
  });

  test('filters out tools that have execute property (server-side tools)', () => {
    const steps = [
      {
        toolCalls: [
          { toolCallId: 'tc1', toolName: 'serverTool', input: { x: 1 } },
        ],
      },
    ];
    const resolvedTools = {
      serverTool: { execute: async () => {}, inputSchema: {} },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = findPendingClientTools(steps, resolvedTools as any);
    expect(result).toEqual([]);
  });

  test('returns client tools (no execute property)', () => {
    const steps = [
      {
        toolCalls: [
          { toolCallId: 'tc1', toolName: 'clientTool', input: { x: 1 } },
        ],
      },
    ];
    const resolvedTools = {
      clientTool: { inputSchema: {} },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = findPendingClientTools(steps, resolvedTools as any);
    expect(result).toHaveLength(1);
    expect(result[0].toolCallId).toBe('tc1');
    expect(result[0].toolName).toBe('clientTool');
  });

  test('handles multiple steps with mixed tool calls', () => {
    const steps = [
      {
        toolCalls: [
          { toolCallId: 'tc1', toolName: 'clientTool', input: {} },
          { toolCallId: 'tc2', toolName: 'serverTool', input: {} },
        ],
      },
      {
        toolCalls: [{ toolCallId: 'tc3', toolName: 'clientTool', input: {} }],
      },
    ];
    const resolvedTools = {
      clientTool: { inputSchema: {} },
      serverTool: { execute: async () => {}, inputSchema: {} },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = findPendingClientTools(steps, resolvedTools as any);
    expect(result).toHaveLength(2);
    expect(
      result.every((r) => {
        return r.toolName === 'clientTool';
      })
    ).toBe(true);
  });
});

const mockAgent: TypedAgent = {
  instructions: null,
  model: 'test-model',
  toolIds: null,
  tools: null,
  maxSteps: 5,
  toolChoice: 'auto',
  stopConditions: null,
  activeToolIds: null,
  stepRules: null,
  boundaryPolicy: null,
  temperature: null,
  knowledgeConfig: null,
  outputSchema: null,
  project: { id: 1, publicId: 'prj_test123' },
  aiProvider: { publicId: 'aip_test123' },
};

describe('savePendingGeneration', () => {
  beforeEach(() => {
    pendingGenerations.clear();
  });

  test('returns requires_action result and stores in pendingGenerations', () => {
    const result = savePendingGeneration({
      generationId: 'gen_test001',
      traceId: 'trc_test001',
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'myTool', input: { x: 1 } },
      ],
      allMessages: [{ role: 'user', content: 'Hello' }],
      result: { steps: [], response: { messages: [] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: {} as any,
      typedAgent: mockAgent,
      agentId: 'agt_test001',
      resolvedTools: {},
    });

    expect(result.status).toBe('requires_action');
    expect(result.id).toBe('gen_test001');
    expect(result.traceId).toBe('trc_test001');
    expect(result.requiredAction?.type).toBe('submit_tool_outputs');
    expect(result.requiredAction?.toolCalls).toHaveLength(1);
    expect(result.requiredAction?.toolCalls[0].toolName).toBe('myTool');
    expect(pendingGenerations.has('gen_test001')).toBe(true);
  });

  test('returns requires_action with multiple pending tool calls', () => {
    const result = savePendingGeneration({
      generationId: 'gen_test002',
      traceId: 'trc_test002',
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'toolA', input: { a: 1 } },
        { toolCallId: 'tc_2', toolName: 'toolB', input: { b: 2 } },
      ],
      allMessages: [{ role: 'user', content: 'Call both tools' }],
      result: { steps: [], response: { messages: [] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: {} as any,
      typedAgent: mockAgent,
      agentId: 'agt_test001',
      resolvedTools: {},
    });

    expect(result.status).toBe('requires_action');
    expect(result.requiredAction?.toolCalls).toHaveLength(2);
  });

  test('does not call saveTrace — trace must not be written mid-generation', () => {
    const saveTraceSpy = jest
      .spyOn(tracesModule, 'saveTrace')
      .mockResolvedValue(undefined);

    savePendingGeneration({
      generationId: 'gen_notrace01',
      traceId: 'trc_notrace01',
      pendingToolCalls: [{ toolCallId: 'tc_1', toolName: 'myTool', input: {} }],
      allMessages: [{ role: 'user', content: 'Hello' }],
      result: { steps: [], response: { messages: [] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: {} as any,
      typedAgent: mockAgent,
      agentId: 'agt_test001',
      resolvedTools: {},
    });

    expect(saveTraceSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('stores first-call steps in pendingGenerations for later trace assembly', () => {
    const firstCallSteps = [{ type: 'tool-call', toolCallId: 'tc_1' }];

    savePendingGeneration({
      generationId: 'gen_steps01',
      traceId: 'trc_steps01',
      pendingToolCalls: [{ toolCallId: 'tc_1', toolName: 'myTool', input: {} }],
      allMessages: [{ role: 'user', content: 'Hello' }],
      result: { steps: firstCallSteps, response: { messages: [] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: {} as any,
      typedAgent: mockAgent,
      agentId: 'agt_test001',
      resolvedTools: {},
    });

    const pending = pendingGenerations.get('gen_steps01');
    expect(pending?.steps).toEqual(firstCallSteps);
  });

  test('uses default maxSteps when typedAgent.maxSteps is null', () => {
    const agentWithoutMaxSteps: TypedAgent = {
      ...mockAgent,
      maxSteps: null,
    };

    savePendingGeneration({
      generationId: 'gen_test003',
      traceId: 'trc_test003',
      pendingToolCalls: [
        { toolCallId: 'tc_default', toolName: 'toolDefault', input: {} },
      ],
      allMessages: [{ role: 'user', content: 'Use defaults' }],
      result: { steps: [], response: { messages: [] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: {} as any,
      typedAgent: agentWithoutMaxSteps,
      agentId: 'agt_test001',
      resolvedTools: {},
    });

    expect(pendingGenerations.get('gen_test003')?.agentConfig.maxSteps).toBe(
      20
    );
  });

  test('does not throw when updateGenerationRecord rejects while saving pending state', async () => {
    jest
      .spyOn(generationsModule, 'updateGenerationRecord')
      .mockRejectedValue(new Error('db down'));

    expect(() => {
      return savePendingGeneration({
        generationId: 'gen_reject001',
        traceId: 'trc_reject001',
        pendingToolCalls: [
          { toolCallId: 'tc_1', toolName: 'myTool', input: {} },
        ],
        allMessages: [{ role: 'user', content: 'Hello' }],
        result: { steps: [], response: { messages: [] } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model: {} as any,
        typedAgent: mockAgent,
        agentId: 'agt_test001',
        resolvedTools: {},
      });
    }).not.toThrow();

    // Flush the microtask queue so the fire-and-forget `.catch` handlers run.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    jest.restoreAllMocks();
  });
});

describe('buildCompletedGenerationResult', () => {
  beforeEach(() => {
    jest.spyOn(tracesModule, 'saveTrace').mockResolvedValue(undefined);
    jest
      .spyOn(generationsModule, 'updateGenerationRecord')
      .mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns completed result and updates traces', async () => {
    const result = await buildCompletedGenerationResult({
      generationId: 'gen_done001',
      traceId: 'trc_done001',
      result: {
        steps: [],
        response: { modelId: 'gpt-4' },
        text: 'Hello world',
        finishReason: 'stop',
      },
      typedAgent: mockAgent,
      agentId: 'agt_test001',
    });

    expect(result.status).toBe('completed');
    expect(result.id).toBe('gen_done001');
    expect(result.traceId).toBe('trc_done001');
    expect(result.output?.content).toBe('Hello world');
    expect(result.output?.finishReason).toBe('stop');
    expect(result.output?.model).toBe('gpt-4');
  });

  test('uses typedAgent model when response has no modelId', async () => {
    const result = await buildCompletedGenerationResult({
      generationId: 'gen_done002',
      traceId: 'trc_done002',
      result: { steps: [], response: {}, text: 'Hi', finishReason: 'stop' },
      typedAgent: mockAgent,
      agentId: 'agt_test001',
    });

    expect(result.output?.model).toBe('test-model');
  });

  test('uses empty string when both response modelId and typedAgent.model are absent', async () => {
    const agentWithoutModel: TypedAgent = { ...mockAgent, model: null };
    const result = await buildCompletedGenerationResult({
      generationId: 'gen_done003',
      traceId: 'trc_done003',
      result: {
        steps: [],
        response: {},
        text: 'No model',
        finishReason: 'stop',
      },
      typedAgent: agentWithoutModel,
      agentId: 'agt_test001',
    });

    expect(result.output?.model).toBe('');
  });

  test('awaits saveTrace before returning so trace file_id is available in sync mode', async () => {
    let saveTraceResolved = false;

    jest.spyOn(tracesModule, 'saveTrace').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      saveTraceResolved = true;
    });

    await buildCompletedGenerationResult({
      generationId: 'gen_await_trace',
      traceId: 'trc_await_trace',
      result: {
        steps: [],
        response: { modelId: 'gpt-4' },
        text: 'Done',
        finishReason: 'stop',
      },
      typedAgent: mockAgent,
      agentId: 'agt_test001',
    });

    expect(saveTraceResolved).toBe(true);
  });

  test('does not throw when updateGenerationRecord rejects', async () => {
    jest
      .spyOn(generationsModule, 'updateGenerationRecord')
      .mockRejectedValueOnce(new Error('db down'));

    const result = await buildCompletedGenerationResult({
      generationId: 'gen_reject002',
      traceId: 'trc_reject002',
      result: {
        steps: [],
        response: { modelId: 'gpt-4' },
        text: 'Hello world',
        finishReason: 'stop',
      },
      typedAgent: mockAgent,
      agentId: 'agt_test001',
    });

    // Flush the microtask queue so the fire-and-forget `.catch` handler runs.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(result.status).toBe('completed');
  });
});

describe('runStreamGeneration', () => {
  test('evaluates default branch options before delegating to streamText', () => {
    expect(() => {
      runStreamGeneration({
        model: {} as never,
        allMessages: [{ role: 'user', content: 'Hello' }],
        resolvedTools: {},
        typedAgent: {
          ...mockAgent,
          maxSteps: null,
          toolChoice: null,
          temperature: null,
        },
        generationId: 'gen_stream_default',
        traceId: 'trc_stream_default',
        agentId: 'agt_stream_default',
      });
    }).toThrow();
  });

  test('evaluates explicit branch options before delegating to streamText', () => {
    const resolvedTools = {
      clientTool: { inputSchema: {} },
    };

    expect(() => {
      runStreamGeneration({
        model: {} as never,
        allMessages: [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: 'Hi' },
        ],
        resolvedTools: resolvedTools as never,
        typedAgent: {
          ...mockAgent,
          maxSteps: 7,
          toolChoice: 'required',
          temperature: 0.4,
        },
        generationId: 'gen_stream_explicit',
        traceId: 'trc_stream_explicit',
        agentId: 'agt_stream_explicit',
      });
    }).toThrow();
  });

  describe('onEnd callback and prepareStep via isolateModules', () => {
    // streamText is non-configurable so jest.spyOn can't override it, and
    // jest.mock at file scope won't intercept the already-loaded module.
    // jest.isolateModules reloads the module fresh inside the mock registry,
    // so we also mock traces and generations inside the same isolated scope.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let isolatedRunStreamGeneration: (...args: any[]) => any;
    const mockStreamTextFn = jest.fn();
    const mockSaveTraceFn = jest.fn().mockResolvedValue(undefined as void);
    const mockUpdateGenerationFn = jest.fn().mockResolvedValue(null);

    beforeEach(() => {
      mockStreamTextFn.mockReset();
      mockSaveTraceFn.mockReset().mockResolvedValue(undefined);
      mockUpdateGenerationFn.mockReset().mockResolvedValue(null);

      jest.isolateModules(() => {
        jest.mock('ai', () => {
          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            streamText: (opts: any) => {
              return mockStreamTextFn(opts);
            },
            isStepCount: () => {
              return () => {
                return false;
              };
            },
          };
        });
        jest.mock('src/lib/traces', () => {
          return {
            saveTrace: mockSaveTraceFn,
            serializeSteps: (s: unknown) => {
              return s;
            },
          };
        });
        jest.mock('src/lib/generations', () => {
          return { updateGenerationRecord: mockUpdateGenerationFn };
        });
        // jest.isolateModules requires require() for synchronous module loading
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
        const mod = require('src/lib/agentGenerationHelpers') as any;
        isolatedRunStreamGeneration = mod.runStreamGeneration;
      });
    });

    test('onEnd callback invokes saveTrace and updateGenerationRecord', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedOpts: Record<string, any> | undefined;
      mockStreamTextFn.mockImplementation((opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { textStream: new ReadableStream() };
      });

      isolatedRunStreamGeneration({
        model: {},
        allMessages: [{ role: 'user', content: 'Hi' }],
        resolvedTools: {},
        typedAgent: mockAgent,
        generationId: 'gen_onfinish',
        traceId: 'trc_onfinish',
        agentId: 'agt_onfinish',
      });

      expect(capturedOpts?.onEnd).toBeDefined();
      await capturedOpts?.onEnd({ steps: [], finishReason: 'stop' });

      expect(mockSaveTraceFn).toHaveBeenCalledTimes(1);
      expect(mockUpdateGenerationFn).toHaveBeenCalledTimes(1);
    });

    test('onEnd callback swallows saveTrace and updateGenerationRecord failures', async () => {
      mockSaveTraceFn.mockRejectedValueOnce(new Error('saveTrace failed'));
      mockUpdateGenerationFn.mockRejectedValueOnce(
        new Error('updateGenerationRecord failed')
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedOpts: Record<string, any> | undefined;
      mockStreamTextFn.mockImplementation((opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { textStream: new ReadableStream() };
      });

      isolatedRunStreamGeneration({
        model: {},
        allMessages: [{ role: 'user', content: 'Hi' }],
        resolvedTools: {},
        typedAgent: mockAgent,
        generationId: 'gen_onfinish_fail',
        traceId: 'trc_onfinish_fail',
        agentId: 'agt_onfinish_fail',
      });

      expect(capturedOpts?.onEnd).toBeDefined();
      // Must not throw or produce an unhandled rejection.
      await capturedOpts?.onEnd({ steps: [], finishReason: 'stop' });

      // Give the fire-and-forget rejected promises a tick to settle.
      await new Promise((resolve) => {
        return setTimeout(resolve, 0);
      });
    });

    test('prepareStep returns toolChoice override when a matching step rule matches', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedOpts: Record<string, any> | undefined;
      mockStreamTextFn.mockImplementation((opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { textStream: new ReadableStream() };
      });

      isolatedRunStreamGeneration({
        model: {},
        allMessages: [{ role: 'user', content: 'Hi' }],
        resolvedTools: {},
        typedAgent: {
          ...mockAgent,
          stepRules: [
            { step: 1, toolChoice: { type: 'tool', toolName: 'myTool' } },
          ],
        },
        generationId: 'gen_steprules',
        traceId: 'trc_steprules',
        agentId: 'agt_steprules',
      });

      expect(capturedOpts?.prepareStep).toBeDefined();
      const result = capturedOpts?.prepareStep({ stepNumber: 0 });
      expect(result).toEqual({
        toolChoice: { type: 'tool', toolName: 'myTool' },
        activeTools: ['myTool'],
      });
    });

    test('prepareStep returns empty object when no step rule matches', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedOpts: Record<string, any> | undefined;
      mockStreamTextFn.mockImplementation((opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { textStream: new ReadableStream() };
      });

      isolatedRunStreamGeneration({
        model: {},
        allMessages: [{ role: 'user', content: 'Hi' }],
        resolvedTools: {},
        typedAgent: {
          ...mockAgent,
          stepRules: [
            { step: 2, toolChoice: { type: 'tool', toolName: 'myTool' } },
          ],
        },
        generationId: 'gen_steprules_nomatch',
        traceId: 'trc_steprules_nomatch',
        agentId: 'agt_steprules_nomatch',
      });

      const result = capturedOpts?.prepareStep({ stepNumber: 0 });
      expect(result).toEqual({});
    });
  });
});
