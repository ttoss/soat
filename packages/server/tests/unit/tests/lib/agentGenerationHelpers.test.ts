import {
  buildAllMessages,
  buildCompletedGenerationResult,
  buildDepthGuardResult,
  findPendingClientTools,
  pendingGenerations,
  savePendingGeneration,
  type TypedAgent,
} from 'src/lib/agentGenerationHelpers';
import { traces } from 'src/lib/agentTraces';

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
      agentId: 'agent-abc',
    });

    expect(result.status).toBe('completed');
    expect(result.traceId).toBe('trace-123');
    expect(result.id).toMatch(/gen_/);
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
  maxSteps: 5,
  toolChoice: 'auto',
  stopConditions: null,
  activeToolIds: null,
  stepRules: null,
  boundaryPolicy: null,
  temperature: null,
  project: { id: 1, publicId: 'prj_test123' },
  aiProvider: { publicId: 'aip_test123' },
};

describe('savePendingGeneration', () => {
  beforeEach(() => {
    traces.clear();
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
    expect(traces.get('trc_test001')?.status).toBe('requires_action');
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
});

describe('buildCompletedGenerationResult', () => {
  beforeEach(() => {
    traces.clear();
  });

  test('returns completed result and updates traces', () => {
    const result = buildCompletedGenerationResult({
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
    expect(traces.get('trc_done001')?.status).toBe('completed');
  });

  test('uses typedAgent model when response has no modelId', () => {
    const result = buildCompletedGenerationResult({
      generationId: 'gen_done002',
      traceId: 'trc_done002',
      result: { steps: [], response: {}, text: 'Hi', finishReason: 'stop' },
      typedAgent: mockAgent,
      agentId: 'agt_test001',
    });

    expect(result.output?.model).toBe('test-model');
  });

  test('uses empty string when both response modelId and typedAgent.model are absent', () => {
    const agentWithoutModel: TypedAgent = { ...mockAgent, model: null };
    const result = buildCompletedGenerationResult({
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
});
