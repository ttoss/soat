import { db } from 'src/db';
import { DomainError } from 'src/errors';
import * as agentGenerationModule from 'src/lib/agentGeneration';
import type { GenerationResult } from 'src/lib/agentGenerationHelpers';
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
} from 'src/lib/orchestrationNodeExecutors';
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
});

describe('executeLoopNode', () => {
  test('throws DomainError when subGraph is missing', async () => {
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
});

// ── Node executor success/error branches (coverage) ────────────────────────

describe('node executor success and error branches', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const makeGen = (content: string): GenerationResult => {
    return {
      id: 'gen_1',
      traceId: 'trc_1',
      status: 'completed',
      output: { model: 'test-model', content, finishReason: 'stop' },
    };
  };

  describe('executeAgentNode (mocked generation)', () => {
    test('parses JSON content into the artifact when outputSchema is set', async () => {
      jest
        .spyOn(agentGenerationModule, 'createGeneration')
        .mockResolvedValueOnce(makeGen('{"foo":"bar"}'));
      const result = await executeAgentNode({
        node: makeNode({
          type: 'agent',
          agentId: 'agt_1',
          outputSchema: { type: 'object' },
          inputMapping: { topic: { var: 'subject' } },
        }),
        state: { subject: 'cats' },
        projectIds: [1],
        traceId: null,
      });
      expect(result).toEqual({ kind: 'artifact', artifact: { foo: 'bar' } });
    });

    test('falls back to { content } when JSON parsing fails', async () => {
      jest
        .spyOn(agentGenerationModule, 'createGeneration')
        .mockResolvedValueOnce(makeGen('not json'));
      const result = await executeAgentNode({
        node: makeNode({
          type: 'agent',
          agentId: 'agt_1',
          outputSchema: { type: 'object' },
        }),
        state: {},
        projectIds: [1],
        traceId: null,
      });
      expect(result).toEqual({
        kind: 'artifact',
        artifact: { content: 'not json' },
      });
    });

    test('returns { content } when no outputSchema is provided', async () => {
      jest
        .spyOn(agentGenerationModule, 'createGeneration')
        .mockResolvedValueOnce(makeGen('hello'));
      const result = await executeAgentNode({
        node: makeNode({ type: 'agent', agentId: 'agt_1' }),
        state: {},
        projectIds: [1],
        traceId: null,
      });
      expect(result).toEqual({
        kind: 'artifact',
        artifact: { content: 'hello' },
      });
    });

    test('throws DomainError when generation returns a stream', async () => {
      jest
        .spyOn(agentGenerationModule, 'createGeneration')
        .mockResolvedValueOnce(new ReadableStream());
      await expect(
        executeAgentNode({
          node: makeNode({ type: 'agent', agentId: 'agt_1' }),
          state: {},
          projectIds: [1],
          traceId: null,
        })
      ).rejects.toThrow(DomainError);
    });
  });

  describe('executeToolNode (mocked callTool)', () => {
    test('wraps a non-object tool result as { result }', async () => {
      jest.spyOn(toolsModule, 'callTool').mockResolvedValueOnce(42);
      const result = await executeToolNode({
        node: makeNode({ type: 'tool', toolId: 'tool_x' }),
        state: {},
        projectIds: [1],
      });
      expect(result).toEqual({ kind: 'artifact', artifact: { result: 42 } });
    });

    test('uses an object tool result directly as the artifact', async () => {
      jest.spyOn(toolsModule, 'callTool').mockResolvedValueOnce({ a: 1 });
      const result = await executeToolNode({
        node: makeNode({
          type: 'tool',
          toolId: 'tool_x',
          inputMapping: { q: { var: 'query' } },
        }),
        state: { query: 'hi' },
        projectIds: [1],
      });
      expect(result).toEqual({ kind: 'artifact', artifact: { a: 1 } });
    });
  });

  describe('executeMemoryWriteNode (mocked db)', () => {
    test('throws DomainError when the memory is not found', async () => {
      jest.spyOn(db.Memory, 'findOne').mockResolvedValueOnce(null);
      await expect(
        executeMemoryWriteNode({
          node: makeNode({ type: 'memory_write', memoryId: 'mem_missing' }),
          state: {},
        })
      ).rejects.toThrow(DomainError);
    });
  });
});
