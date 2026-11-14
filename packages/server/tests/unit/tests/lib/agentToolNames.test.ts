import { jsonSchema, type Tool, tool } from 'ai';
import type { ResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import {
  gateAndMergeBindings,
  RESULT_PROVENANCE,
  type ToolBinding,
} from 'src/lib/agentToolNames';

// The entry-point case (two bindings, one action) is pinned in
// `rest/agentExternalTools.test.ts`; these are the naming edges.

const stub = (description: string): Tool => {
  return tool({
    description,
    inputSchema: jsonSchema({ type: 'object' }),
  });
};

// Every merged tool carries the counter its results feed.
const merged = (resolved: Tool) => {
  return { ...resolved, [RESULT_PROVENANCE]: 'untrusted_tool_results' };
};

// No guardrail applies, so the gate passes each tool through and only naming
// is under test.
const guardrail: ResolverGuardrailContext = {
  agentId: null,
  generationId: null,
  projectId: 1,
  projectPublicId: 'proj_test',
  authority: null,
  callerContext: {},
  baseGuardrails: [],
  provenance: null,
};

const binding = (
  bindingName: string,
  tools: Record<string, Tool>
): ToolBinding => {
  return {
    bindingName,
    tools,
    gate: {
      toolId: null,
      toolType: 'http',
      toolName: bindingName,
      toolGuardrails: [],
      trustedOutput: false,
    },
  };
};

const mergeBindingTools = (args: { bindings: ToolBinding[] }) => {
  return gateAndMergeBindings({ bindings: args.bindings, guardrail });
};

describe('gateAndMergeBindings naming', () => {
  test('a key one binding resolves keeps its name', () => {
    const only = stub('only');

    expect(
      mergeBindingTools({
        bindings: [binding('a', { x: only })],
      })
    ).toEqual({ x: merged(only) });
  });

  test('a shared key is offered once per binding under its binding name', () => {
    const fromA = stub('fromA');
    const fromB = stub('fromB');

    const tools = mergeBindingTools({
      bindings: [binding('a', { x: fromA }), binding('b', { x: fromB })],
    });

    expect(tools).toEqual({ a_x: merged(fromA), b_x: merged(fromB) });
  });

  test('a namespaced name that is already taken gets an ordinal', () => {
    const plain = stub('plain');
    const fromA = stub('fromA');
    const fromSameName = stub('fromSameName');

    const tools = mergeBindingTools({
      bindings: [
        binding('other', { a_x: plain }),
        binding('a', { x: fromA }),
        binding('a', { x: fromSameName }),
      ],
    });

    expect(tools).toEqual({
      a_x: merged(plain),
      a_x_2: merged(fromA),
      a_x_3: merged(fromSameName),
    });
  });
});
