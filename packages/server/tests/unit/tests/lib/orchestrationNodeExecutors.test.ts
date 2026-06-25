import { DomainError } from 'src/errors';
import {
  applyInputMapping,
  applyOutputMapping,
  executeAgentNode,
  executeConditionNode,
  executeDelayNode,
  executeHumanNode,
  executeLoopNode,
  executeMemoryWriteNode,
  executeSubOrchestrationNode,
  executeToolNode,
  executeTransformNode,
  executeWebhookNode,
  parseDuration,
} from 'src/lib/orchestrationNodeExecutors';
import { executePollNode } from 'src/lib/orchestrationPollNode';
import type { OrchestrationNode } from 'src/lib/orchestrations';
import * as toolsModule from 'src/lib/tools';

const makeNode = (
  overrides: Partial<OrchestrationNode> = {}
): OrchestrationNode => {
  return {
    id: 'n1',
    type: 'transform',
    ...overrides,
  };
};

// ── applyInputMapping ──────────────────────────────────────────────────────

describe('applyInputMapping', () => {
  test('returns empty object when inputMapping is undefined', () => {
    expect(applyInputMapping(undefined, {})).toEqual({});
  });

  test('passes literal values (string, number, boolean, array) as-is', () => {
    expect(
      applyInputMapping(
        {
          language: 'pt-BR',
          threshold: 0.8,
          enabled: true,
          tags: ['reel', 'video'],
        },
        {}
      )
    ).toEqual({
      language: 'pt-BR',
      threshold: 0.8,
      enabled: true,
      tags: ['reel', 'video'],
    });
  });

  test('resolves {var: "key"} from state', () => {
    const state = { temaDocumentId: 'ood_123' };
    expect(
      applyInputMapping({ documentId: { var: 'temaDocumentId' } }, state)
    ).toEqual({ documentId: 'ood_123' });
  });

  test('resolves a nested {var: "a.b"} path from state', () => {
    const state = { user: { age: 30 } };
    expect(applyInputMapping({ age: { var: 'user.age' } }, state)).toEqual({
      age: 30,
    });
  });

  test('a missing {var} resolves to null', () => {
    expect(applyInputMapping({ key: { var: 'missing' } }, {})).toEqual({
      key: null,
    });
  });

  test('evaluates a {cat} expression against state', () => {
    const state = { titulo: 'My Theme' };
    expect(
      applyInputMapping(
        { label: { cat: ['Tema: ', { var: 'titulo' }] } },
        state
      )
    ).toEqual({ label: 'Tema: My Theme' });
  });

  test('evaluates a comparison expression to a boolean', () => {
    expect(
      applyInputMapping(
        { isLong: { '>': [{ var: 'wordCount' }, 500] } },
        { wordCount: 750 }
      )
    ).toEqual({ isLong: true });
  });

  test('passes a multi-key object through as a literal (not a JSON Logic rule)', () => {
    const literal = { a: 1, b: 2 };
    expect(applyInputMapping({ config: literal }, {})).toEqual({
      config: literal,
    });
  });

  test('a plain string is a literal, not a state path', () => {
    // Breaking change from the legacy 'state.X' path syntax: bare strings are
    // now literals; state references must use {var: 'X'}.
    expect(applyInputMapping({ key: 'state.name' }, { name: 'Alice' })).toEqual(
      {
        key: 'state.name',
      }
    );
  });
});

// ── applyOutputMapping ─────────────────────────────────────────────────────

describe('applyOutputMapping', () => {
  test('does nothing when outputMapping is undefined', () => {
    const state: Record<string, unknown> = {};
    applyOutputMapping(undefined, { result: 42 }, state);
    expect(state).toEqual({});
  });

  test('writes artifact value to state under the mapped key', () => {
    const state: Record<string, unknown> = {};
    applyOutputMapping({ result: 'state.output' }, { result: 42 }, state);
    expect(state['output']).toBe(42);
  });

  test('non-state output path is silently ignored', () => {
    const state: Record<string, unknown> = {};
    applyOutputMapping({ result: 'env.output' }, { result: 42 }, state);
    expect(Object.keys(state)).toHaveLength(0);
  });
});

// ── executeTransformNode ───────────────────────────────────────────────────

describe('executeTransformNode', () => {
  test('evaluates a constant expression and returns artifact', () => {
    const result = executeTransformNode({
      node: makeNode({ expression: 42 }),
      state: {},
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { result: 42 } });
  });

  test('evaluates a json-logic var expression with state', () => {
    const result = executeTransformNode({
      node: makeNode({ expression: { var: 'score' } }),
      state: { score: 99 },
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { result: 99 } });
  });

  test('throws DomainError when expression is null', () => {
    expect(() => {
      return executeTransformNode({
        node: makeNode({ expression: null }),
        state: {},
      });
    }).toThrow(DomainError);
  });

  test('throws DomainError when expression is undefined', () => {
    expect(() => {
      return executeTransformNode({ node: makeNode({}), state: {} });
    }).toThrow(DomainError);
  });
});

// ── executeAgentNode ───────────────────────────────────────────────────────

describe('executeAgentNode', () => {
  test('throws DomainError when agentId is missing', async () => {
    await expect(
      executeAgentNode({
        node: makeNode({ type: 'agent' }),
        state: {},
        projectIds: [1],
        traceId: null,
      })
    ).rejects.toThrow(DomainError);
  });
});

// ── executeMemoryWriteNode ─────────────────────────────────────────────────

describe('executeMemoryWriteNode', () => {
  test('throws DomainError when memoryId is missing', async () => {
    await expect(
      executeMemoryWriteNode({
        node: makeNode({ type: 'memory_write' }),
        state: {},
      })
    ).rejects.toThrow(DomainError);
  });
});

// ── executeConditionNode ───────────────────────────────────────────────────

describe('executeConditionNode', () => {
  test('returns condition label from expression result', () => {
    const result = executeConditionNode({
      node: makeNode({ type: 'condition', expression: 'yes' }),
      state: {},
    });
    expect(result).toEqual({ kind: 'condition', label: 'yes' });
  });

  test('coerces numeric expression result to string label', () => {
    const result = executeConditionNode({
      node: makeNode({ type: 'condition', expression: 42 }),
      state: {},
    });
    expect(result).toEqual({ kind: 'condition', label: '42' });
  });

  test('throws DomainError when expression is null', () => {
    expect(() => {
      return executeConditionNode({
        node: makeNode({ type: 'condition', expression: null }),
        state: {},
      });
    }).toThrow(DomainError);
  });

  test('throws DomainError when expression is undefined', () => {
    expect(() => {
      return executeConditionNode({
        node: makeNode({ type: 'condition' }),
        state: {},
      });
    }).toThrow(DomainError);
  });
});

// ── executeHumanNode ───────────────────────────────────────────────────────

describe('executeHumanNode', () => {
  test('returns requires_action with prompt, nodeId, context and options', () => {
    const result = executeHumanNode({
      node: makeNode({
        type: 'human',
        prompt: 'Approve?',
        options: ['yes', 'no'],
      }),
      state: {},
    });
    expect(result.kind).toBe('requires_action');
    const ra = result as Extract<typeof result, { kind: 'requires_action' }>;
    expect(ra.nodeId).toBe('n1');
    expect(ra.prompt).toBe('Approve?');
    expect(ra.options).toEqual(['yes', 'no']);
    expect(ra.context).toEqual({});
  });

  test('uses default prompt when node.prompt is undefined', () => {
    const result = executeHumanNode({
      node: makeNode({ type: 'human' }),
      state: {},
    });
    const ra = result as Extract<typeof result, { kind: 'requires_action' }>;
    expect(ra.prompt).toBe('Human input required.');
  });

  test('populates context from inputMapping', () => {
    const result = executeHumanNode({
      node: makeNode({
        type: 'human',
        prompt: 'Review?',
        inputMapping: { data: { var: 'item' } },
      }),
      state: { item: 'hello' },
    });
    const ra = result as Extract<typeof result, { kind: 'requires_action' }>;
    expect(ra.context).toEqual({ data: 'hello' });
  });
});

// ── executeWebhookNode ─────────────────────────────────────────────────────

describe('executeWebhookNode', () => {
  test('emit mode without webhookUrl returns emitted artifact', () => {
    const result = executeWebhookNode({
      node: makeNode({ type: 'webhook', mode: 'emit' }),
      state: {},
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { emitted: true } });
  });

  test('undefined mode defaults to emit behaviour', () => {
    const result = executeWebhookNode({
      node: makeNode({ type: 'webhook' }),
      state: {},
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { emitted: true } });
  });

  test('emit mode fires fetch with webhookUrl (best-effort, no throw)', () => {
    // fetch is fire-and-forget; any network error is swallowed by .catch()
    expect(() => {
      return executeWebhookNode({
        node: makeNode({
          type: 'webhook',
          mode: 'emit',
          webhookUrl: 'http://localhost:0/noop',
        }),
        state: { val: 1 },
      });
    }).not.toThrow();
  });

  test('receive mode returns requires_action with prompt and context', () => {
    const result = executeWebhookNode({
      node: makeNode({
        type: 'webhook',
        mode: 'receive',
        inputMapping: { token: { var: 'tok' } },
      }),
      state: { tok: 'abc' },
    });
    expect(result.kind).toBe('requires_action');
    const ra = result as Extract<typeof result, { kind: 'requires_action' }>;
    expect(ra.prompt).toBe('Waiting for webhook callback.');
    expect(ra.context).toEqual({ token: 'abc' });
  });
});

// ── executeDelayNode ───────────────────────────────────────────────────────

describe('executeToolNode', () => {
  test('throws DomainError when toolId is missing', async () => {
    await expect(
      executeToolNode({
        node: makeNode({ type: 'tool' }),
        state: {},
        projectIds: [1],
      })
    ).rejects.toThrow(DomainError);
  });

  test('returns an object tool result as the artifact', async () => {
    const spy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ ok: true, value: 7 });
    try {
      const result = await executeToolNode({
        node: makeNode({ type: 'tool', toolId: 'tool_x' }),
        state: {},
        projectIds: [1],
      });
      expect(result).toEqual({
        kind: 'artifact',
        artifact: { ok: true, value: 7 },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('wraps a primitive tool result under a result key', async () => {
    const spy = jest.spyOn(toolsModule, 'callTool').mockResolvedValue('done');
    try {
      const result = await executeToolNode({
        node: makeNode({ type: 'tool', toolId: 'tool_x' }),
        state: {},
        projectIds: [1],
      });
      expect(result).toEqual({
        kind: 'artifact',
        artifact: { result: 'done' },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('executeLoopNode', () => {
  test('throws DomainError when orchestrationId is missing', async () => {
    await expect(
      executeLoopNode({
        node: makeNode({ type: 'loop' }),
        state: {},
        projectIds: [1],
        traceId: null,
      })
    ).rejects.toThrow(DomainError);
  });
});

describe('executeSubOrchestrationNode', () => {
  test('throws DomainError when orchestrationId is missing', async () => {
    await expect(
      executeSubOrchestrationNode({
        node: makeNode({ type: 'sub_orchestration' }),
        state: {},
        projectIds: [1],
        traceId: null,
      })
    ).rejects.toThrow(DomainError);
  });
});

describe('executeDelayNode', () => {
  test('throws DomainError when duration is missing', async () => {
    await expect(
      executeDelayNode({ node: makeNode({ type: 'delay' }) })
    ).rejects.toThrow(DomainError);
  });

  test('completes immediately for PT0S (zero-duration)', async () => {
    const result = await executeDelayNode({
      node: makeNode({ type: 'delay', duration: 'PT0S' }),
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { waited: 'PT0S' } });
  });

  test('returns zero ms for invalid ISO duration string (no-op delay)', async () => {
    const result = await executeDelayNode({
      node: makeNode({ type: 'delay', duration: 'INVALID' }),
    });
    expect(result).toEqual({
      kind: 'artifact',
      artifact: { waited: 'INVALID' },
    });
  });

  test('handles P0D (days only, zero) format', async () => {
    const result = await executeDelayNode({
      node: makeNode({ type: 'delay', duration: 'P0D' }),
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { waited: 'P0D' } });
  });

  test('handles PT0H0M0S (all zero components) format', async () => {
    const result = await executeDelayNode({
      node: makeNode({ type: 'delay', duration: 'PT0H0M0S' }),
    });
    expect(result).toEqual({
      kind: 'artifact',
      artifact: { waited: 'PT0H0M0S' },
    });
  });

  test('accepts the friendly suffix form (0s) for an instant wait', async () => {
    const result = await executeDelayNode({
      node: makeNode({ type: 'delay', duration: '0s' }),
    });
    expect(result).toEqual({ kind: 'artifact', artifact: { waited: '0s' } });
  });
});

// ── parseDuration ──────────────────────────────────────────────────────────

describe('parseDuration', () => {
  test('parses the friendly suffix form', () => {
    expect(parseDuration('5s')).toBe(5000);
    expect(parseDuration('30s')).toBe(30000);
    expect(parseDuration('5m')).toBe(300000);
    expect(parseDuration('2h')).toBe(7200000);
    expect(parseDuration('1d')).toBe(86400000);
    expect(parseDuration('500ms')).toBe(500);
  });

  test('parses ISO 8601 durations', () => {
    expect(parseDuration('PT5S')).toBe(5000);
    expect(parseDuration('PT1M30S')).toBe(90000);
    expect(parseDuration('P1DT2H')).toBe(93600000);
  });

  test('returns 0 for unparseable input', () => {
    expect(parseDuration('INVALID')).toBe(0);
    expect(parseDuration('')).toBe(0);
  });
});

// ── executePollNode ────────────────────────────────────────────────────────

describe('executePollNode', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const pollNode = (overrides: Partial<OrchestrationNode> = {}) => {
    return makeNode({
      type: 'poll',
      toolId: 'tool_status',
      interval: '0s',
      exitCondition: { '==': [{ var: 'response.status' }, 'completed'] },
      ...overrides,
    });
  };

  test('throws DomainError when toolId is missing', async () => {
    await expect(
      executePollNode({
        node: pollNode({ toolId: undefined }),
        state: {},
        projectIds: [1],
      })
    ).rejects.toThrow(DomainError);
  });

  test('throws DomainError when exitCondition is missing', async () => {
    await expect(
      executePollNode({
        node: pollNode({ exitCondition: undefined }),
        state: {},
        projectIds: [1],
      })
    ).rejects.toThrow(DomainError);
  });

  test('throws DomainError when interval is missing', async () => {
    await expect(
      executePollNode({
        node: pollNode({ interval: undefined }),
        state: {},
        projectIds: [1],
      })
    ).rejects.toThrow(DomainError);
  });

  test('completes on the first attempt when the condition is already true', async () => {
    const spy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ status: 'completed' });

    const result = await executePollNode({
      node: pollNode(),
      state: {},
      projectIds: [1],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'artifact',
      artifact: {
        result: { status: 'completed' },
        attempts: 1,
        conditionMet: true,
        timedOut: false,
      },
    });
  });

  test('polls until the exit condition becomes true', async () => {
    const spy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'completed' });

    const result = await executePollNode({
      node: pollNode(),
      state: {},
      projectIds: [1],
    });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      kind: 'artifact',
      artifact: {
        result: { status: 'completed' },
        attempts: 3,
        conditionMet: true,
        timedOut: false,
      },
    });
  });

  test('passes input_mapping and the augmented context to the condition', async () => {
    const spy = jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ status: 'completed' });

    await executePollNode({
      node: pollNode({ inputMapping: { id: { var: 'jobId' } } }),
      state: { jobId: 'job_123' },
      projectIds: [7],
      authHeader: 'Bearer t',
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool_status',
        input: { id: 'job_123' },
        projectIds: [7],
        authHeader: 'Bearer t',
      })
    );
  });

  test('completes with conditionMet=false when attempts are exhausted', async () => {
    jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ status: 'pending' });

    const result = await executePollNode({
      node: pollNode({ maxIterations: 3 }),
      state: {},
      projectIds: [1],
    });

    expect(result).toEqual({
      kind: 'artifact',
      artifact: {
        result: { status: 'pending' },
        attempts: 3,
        conditionMet: false,
        timedOut: true,
      },
    });
  });

  test('throws ORCHESTRATION_POLL_EXHAUSTED when fail_on_timeout is set', async () => {
    jest
      .spyOn(toolsModule, 'callTool')
      .mockResolvedValue({ status: 'pending' });

    await expect(
      executePollNode({
        node: pollNode({ maxIterations: 2, failOnTimeout: true }),
        state: {},
        projectIds: [1],
      })
    ).rejects.toThrow(DomainError);
  });
});
