import { jsonSchema, type Tool, tool } from 'ai';
import { mergeBindingTools } from 'src/lib/agentToolNames';

// The entry-point case (two bindings, one action) is pinned in
// `rest/agentExternalTools.test.ts`; these are the naming edges.

const stub = (): Tool => {
  return tool({
    description: 'stub',
    inputSchema: jsonSchema({ type: 'object' }),
  });
};

describe('mergeBindingTools', () => {
  test('a key one binding resolves keeps its name', () => {
    const only = stub();

    expect(
      mergeBindingTools({
        bindings: [{ bindingName: 'a', tools: { x: only } }],
      })
    ).toEqual({ x: only });
  });

  test('a shared key is offered once per binding under its binding name', () => {
    const fromA = stub();
    const fromB = stub();

    const merged = mergeBindingTools({
      bindings: [
        { bindingName: 'a', tools: { x: fromA } },
        { bindingName: 'b', tools: { x: fromB } },
      ],
    });

    expect(merged).toEqual({ a_x: fromA, b_x: fromB });
  });

  test('a namespaced name that is already taken gets an ordinal', () => {
    const plain = stub();
    const fromA = stub();
    const fromSameName = stub();

    const merged = mergeBindingTools({
      bindings: [
        { bindingName: 'other', tools: { a_x: plain } },
        { bindingName: 'a', tools: { x: fromA } },
        { bindingName: 'a', tools: { x: fromSameName } },
      ],
    });

    expect(merged).toEqual({ a_x: plain, a_x_2: fromA, a_x_3: fromSameName });
  });
});
