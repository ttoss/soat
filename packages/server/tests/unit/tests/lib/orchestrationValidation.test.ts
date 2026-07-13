import type {
  OrchestrationEdge,
  OrchestrationNode,
} from 'src/lib/orchestrations';
import {
  collectVarRefs,
  validateOrchestrationGraph,
} from 'src/lib/orchestrationValidation';

const validate = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  inputSchema?: object | null;
}) => {
  return validateOrchestrationGraph(args);
};

describe('collectVarRefs', () => {
  test('extracts a simple var reference', () => {
    expect(collectVarRefs({ var: 'foo' })).toEqual(['foo']);
  });

  test('extracts var with default array form', () => {
    expect(collectVarRefs({ var: ['foo', 'fallback'] })).toEqual(['foo']);
  });

  test('extracts nested var references inside operators', () => {
    expect(
      collectVarRefs({ '+': [{ var: 'a' }, { cat: [{ var: 'b' }, 'x'] }] })
    ).toEqual(['a', 'b']);
  });

  test('ignores the empty (whole-state) path and numeric indices', () => {
    expect(collectVarRefs({ var: '' })).toEqual([]);
    expect(collectVarRefs({ var: 0 })).toEqual([]);
  });

  test('returns nothing for literals', () => {
    expect(collectVarRefs('hello')).toEqual([]);
    expect(collectVarRefs(42)).toEqual([]);
  });
});

describe('validateOrchestrationGraph', () => {
  describe('node shape', () => {
    test('flags a node missing its required field', () => {
      const result = validate({
        nodes: [{ id: 'a', type: 'agent' }],
        edges: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("missing required field 'agentId'"),
        })
      );
    });

    test('accepts a node that has its required field', () => {
      const result = validate({
        nodes: [{ id: 'a', type: 'agent', agentId: 'agt_1' }],
        edges: [],
      });
      expect(result.valid).toBe(true);
    });

    test('rejects a tool node that has action instead of operationId', () => {
      const rawNode = {
        id: 'n1',
        type: 'tool',
        toolId: 'tool_abc',
        action: 'listAgents',
      } as unknown as OrchestrationNode;
      const result = validate({ nodes: [rawNode], edges: [] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('operationId'),
        })
      );
    });

    test('accepts a tool node with operationId and no action', () => {
      const result = validate({
        nodes: [
          {
            id: 'n1',
            type: 'tool',
            toolId: 'tool_abc',
            operationId: 'listAgents',
          },
        ],
        edges: [],
      });
      expect(result.valid).toBe(true);
    });

    test('flags a poll node missing toolId, exitCondition and interval', () => {
      const result = validate({
        nodes: [{ id: 'p', type: 'poll' }],
        edges: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("missing required field 'toolId'"),
        })
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'nodes[0].exit_condition',
          message: expect.stringContaining('stop condition'),
        })
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'nodes[0].interval',
          message: expect.stringContaining("'interval'"),
        })
      );
    });

    test('accepts a fully specified poll node', () => {
      const result = validate({
        nodes: [
          {
            id: 'p',
            type: 'poll',
            toolId: 'tool_abc',
            interval: '5s',
            exitCondition: { '==': [{ var: 'response.status' }, 'completed'] },
          },
        ],
        edges: [],
      });
      expect(result.valid).toBe(true);
    });

    test('flags duplicate node ids', () => {
      const result = validate({
        nodes: [
          { id: 'dup', type: 'transform', expression: 1 },
          { id: 'dup', type: 'transform', expression: 2 },
        ],
        edges: [],
      });
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("Duplicate node id 'dup'"),
        })
      );
    });
  });

  describe('edges', () => {
    test('flags an edge referencing an unknown node', () => {
      const result = validate({
        nodes: [{ id: 'a', type: 'transform', expression: 1 }],
        edges: [{ from: 'a', to: 'ghost' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'edges[0].to',
          message: expect.stringContaining("unknown node 'ghost'"),
        })
      );
    });

    test('flags a cycle when no loop node is present', () => {
      const result = validate({
        nodes: [
          { id: 'a', type: 'transform', expression: 1 },
          { id: 'b', type: 'transform', expression: 2 },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      });
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Cycle detected'),
        })
      );
    });

    test('allows a cycle when a loop node is present', () => {
      const result = validate({
        nodes: [
          { id: 'a', type: 'loop', orchestrationId: 'orch_child' },
          { id: 'b', type: 'transform', expression: 2 },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      });
      expect(
        result.errors.some((e) => {
          return e.message.includes('Cycle');
        })
      ).toBe(false);
    });
  });

  describe('inputMapping reachability', () => {
    test('errors when a referenced state key is never written upstream (closed input contract)', () => {
      const result = validate({
        nodes: [
          { id: 'a', type: 'transform', expression: 1 },
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'missing' } },
          },
        ],
        edges: [{ from: 'a', to: 'b' }],
        inputSchema: {
          type: 'object',
          properties: { other: { type: 'string' } },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'nodes[1].input_mapping.val',
          message: expect.stringContaining(
            "no upstream node writes 'state.missing'"
          ),
        })
      );
    });

    test('does not error on an unwritten ref when no input_schema is declared (open contract)', () => {
      const result = validate({
        nodes: [
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'fromRunInput' } },
          },
        ],
        edges: [],
      });
      expect(result.valid).toBe(true);
    });

    test('accepts a reference written by an upstream node', () => {
      const result = validate({
        nodes: [
          {
            id: 'a',
            type: 'transform',
            expression: 1,
            outputMapping: { result: 'state.step1' },
          },
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'step1' } },
          },
        ],
        edges: [{ from: 'a', to: 'b' }],
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('accepts a reference written by an upstream node whose outputMapping value omits the state. prefix', () => {
      const result = validate({
        nodes: [
          {
            id: 'a',
            type: 'transform',
            expression: 1,
            outputMapping: { result: 'step1' },
          },
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'step1' } },
          },
        ],
        edges: [{ from: 'a', to: 'b' }],
        inputSchema: {
          type: 'object',
          properties: { other: { type: 'string' } },
        },
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('accepts a reference satisfied by the run input schema', () => {
      const result = validate({
        nodes: [
          {
            id: 'a',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'seed' } },
          },
        ],
        edges: [],
        inputSchema: {
          type: 'object',
          properties: { seed: { type: 'string' } },
        },
      });
      expect(result.valid).toBe(true);
    });

    test('accepts a reference satisfied by an input schema with no `properties` key', () => {
      // Falls back to scanning the schema's own top-level keys (excluding
      // JSON-schema keywords) when `properties` is absent.
      const result = validate({
        nodes: [
          {
            id: 'a',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'seed' } },
          },
        ],
        edges: [],
        inputSchema: {
          type: 'object',
          seed: { type: 'string' },
        },
      });
      expect(result.valid).toBe(true);
    });

    test('accepts a namespaced `input.<name>` reference against the input schema', () => {
      // The run input is seeded under an `input` namespace (matching the
      // pipeline/formation `{ "var": "input.<name>" }` convention), so a
      // reference through that namespace must validate even with a closed
      // input_schema — it used to be rejected as "no upstream node writes
      // 'state.input'".
      const result = validate({
        nodes: [
          {
            id: 'a',
            type: 'transform',
            expression: 1,
            inputMapping: { prompt: { var: 'input.cycle_task' } },
          },
        ],
        edges: [],
        inputSchema: {
          type: 'object',
          properties: { cycle_task: { type: 'string' } },
        },
      });
      expect(result.valid).toBe(true);
    });

    test('errors when the writer is a parallel (non-upstream) node', () => {
      const result = validate({
        nodes: [
          {
            id: 'writer',
            type: 'transform',
            expression: 1,
            outputMapping: { result: 'state.shared' },
          },
          {
            id: 'reader',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'shared' } },
          },
        ],
        edges: [],
        inputSchema: {
          type: 'object',
          properties: { other: { type: 'string' } },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'nodes[1].input_mapping.val',
        })
      );
    });

    test('warns when a key is only written on a conditional branch', () => {
      const result = validate({
        nodes: [
          { id: 'cond', type: 'condition', expression: 'yes' },
          {
            id: 'yes_node',
            type: 'transform',
            expression: 1,
            outputMapping: { result: 'state.branch' },
          },
          {
            id: 'no_node',
            type: 'transform',
            expression: 2,
          },
          {
            id: 'join',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'branch' } },
          },
        ],
        edges: [
          { from: 'cond', to: 'yes_node', condition: 'yes' },
          { from: 'cond', to: 'no_node', condition: 'no' },
          { from: 'yes_node', to: 'join' },
          { from: 'no_node', to: 'join' },
        ],
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          path: 'nodes[3].input_mapping.val',
          message: expect.stringContaining('conditional branch'),
        })
      );
    });

    test('does not produce a false error when both branches write the key', () => {
      const result = validate({
        nodes: [
          { id: 'cond', type: 'condition', expression: 'yes' },
          {
            id: 'yes_node',
            type: 'transform',
            expression: 1,
            outputMapping: { result: 'state.branch' },
          },
          {
            id: 'no_node',
            type: 'transform',
            expression: 2,
            outputMapping: { result: 'state.branch' },
          },
          {
            id: 'join',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'branch' } },
          },
        ],
        edges: [
          { from: 'cond', to: 'yes_node', condition: 'yes' },
          { from: 'cond', to: 'no_node', condition: 'no' },
          { from: 'yes_node', to: 'join' },
          { from: 'no_node', to: 'join' },
        ],
      });
      // Both branches write state.branch, but neither writer dominates the
      // join (they are mutually exclusive), so this remains a warning rather
      // than a guaranteed write. The important guarantee is: no false error.
      expect(result.valid).toBe(true);
    });

    test('skips reachability analysis when an edge is dangling', () => {
      const result = validate({
        nodes: [
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'missing' } },
          },
        ],
        edges: [{ from: 'ghost', to: 'b' }],
      });
      // The dangling-edge error is reported; reachability is not analysed.
      expect(
        result.errors.some((e) => {
          return e.path === 'edges[0].from';
        })
      ).toBe(true);
      expect(
        result.errors.some((e) => {
          return e.path === 'nodes[0].input_mapping.val';
        })
      ).toBe(false);
    });
  });
});
