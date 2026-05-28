import { DomainError } from 'src/errors';
import {
  applyInputMapping,
  applyOutputMapping,
  executeConditionNode,
  executeDelayNode,
  executeHumanNode,
  executeTransformNode,
  executeWebhookNode,
} from 'src/lib/orchestrationNodeExecutors';
import type { OrchestrationNode } from 'src/lib/orchestrations';

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

  test('resolves a state path to its value', () => {
    const state = { name: 'Alice' };
    expect(applyInputMapping({ key: 'state.name' }, state)).toEqual({
      key: 'Alice',
    });
  });

  test('non-state path returns undefined', () => {
    expect(applyInputMapping({ key: 'env.name' }, { name: 'Alice' })).toEqual({
      key: undefined,
    });
  });

  test('deep state path traversal', () => {
    const state = { user: { age: 30 } };
    expect(applyInputMapping({ age: 'state.user.age' }, state)).toEqual({
      age: 30,
    });
  });

  test('deep path through null cursor returns undefined', () => {
    expect(applyInputMapping({ val: 'state.x.y' }, { x: null })).toEqual({
      val: undefined,
    });
  });

  test('deep path through a non-object (string) returns undefined', () => {
    expect(applyInputMapping({ val: 'state.x.y' }, { x: 'string' })).toEqual({
      val: undefined,
    });
  });

  test('missing intermediate key returns undefined', () => {
    expect(applyInputMapping({ val: 'state.missing.deep' }, {})).toEqual({
      val: undefined,
    });
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
        inputMapping: { data: 'state.item' },
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
        inputMapping: { token: 'state.tok' },
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
