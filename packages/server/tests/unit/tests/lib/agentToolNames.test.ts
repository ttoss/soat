import { jsonSchema, type Tool, tool } from 'ai';
import {
  type BindingTools,
  type GatedTools,
  mergeBindingTools,
} from 'src/lib/agentToolNames';

// The entry-point case (two bindings, one action) is pinned in
// `rest/agentExternalTools.test.ts`; these are the naming edges.

const stub = (): Tool => {
  return tool({
    description: 'stub',
    inputSchema: jsonSchema({ type: 'object' }),
  });
};

// Naming is independent of gating, so these bindings stand in for gated ones.
const binding = (
  bindingName: string,
  tools: Record<string, Tool>
): BindingTools => {
  return { bindingName, tools: tools as GatedTools };
};

describe('mergeBindingTools', () => {
  test('a key one binding resolves keeps its name', () => {
    const only = stub();

    expect(
      mergeBindingTools({
        bindings: [binding('a', { x: only })],
      })
    ).toEqual({ x: only });
  });

  test('a shared key is offered once per binding under its binding name', () => {
    const fromA = stub();
    const fromB = stub();

    const merged = mergeBindingTools({
      bindings: [binding('a', { x: fromA }), binding('b', { x: fromB })],
    });

    expect(merged).toEqual({ a_x: fromA, b_x: fromB });
  });

  test('a namespaced name that is already taken gets an ordinal', () => {
    const plain = stub();
    const fromA = stub();
    const fromSameName = stub();

    const merged = mergeBindingTools({
      bindings: [
        binding('other', { a_x: plain }),
        binding('a', { x: fromA }),
        binding('a', { x: fromSameName }),
      ],
    });

    expect(merged).toEqual({ a_x: plain, a_x_2: fromA, a_x_3: fromSameName });
  });
});
