import {
  buildAllMessages,
  buildDepthGuardResult,
  findPendingClientTools,
} from 'src/lib/agentGenerationHelpers';

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
    expect(result.every((r) => r.toolName === 'clientTool')).toBe(true);
  });
});
