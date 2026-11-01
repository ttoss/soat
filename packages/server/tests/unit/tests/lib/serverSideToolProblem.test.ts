import { serverSideToolProblem } from 'src/lib/toolsCallDispatch';

describe('serverSideToolProblem', () => {
  test.each([
    { type: 'client', action: 'x', input: 'open', expected: 'runs_on_client' },
    {
      type: 'mcp',
      action: undefined,
      input: 'open',
      expected: 'action_required',
    },
    { type: 'mcp', action: 'search', input: {}, expected: null },
    {
      type: 'mcp',
      action: null,
      input: { action: 'search' },
      expected: 'action_required',
    },
    { type: 'builtin', action: undefined, input: 'open', expected: null },
    {
      type: 'builtin',
      action: undefined,
      input: {},
      expected: 'action_required',
    },
    {
      type: 'builtin',
      action: undefined,
      input: null,
      expected: 'action_required',
    },
    { type: 'builtin', action: 'list-tools', input: {}, expected: null },
    {
      type: 'builtin',
      action: undefined,
      input: { action: 'list-tools' },
      expected: null,
    },
    { type: 'http', action: undefined, input: {}, expected: null },
    { type: 'pipeline', action: undefined, input: {}, expected: null },
  ] as const)(
    '$type with action $action and input $input → $expected',
    ({ type, action, input, expected }) => {
      expect(
        serverSideToolProblem({
          tool: { type, presetParameters: null },
          action,
          input,
        })
      ).toBe(expected);
    }
  );

  test("a builtin tool's own preset action counts", () => {
    expect(
      serverSideToolProblem({
        tool: { type: 'builtin', presetParameters: { action: 'list-tools' } },
        action: undefined,
        input: {},
      })
    ).toBeNull();
  });
});
