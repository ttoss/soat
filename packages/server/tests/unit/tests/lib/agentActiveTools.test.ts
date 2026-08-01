import { narrowToActiveTools } from 'src/lib/agents';

/**
 * `active_tool_ids` is a restriction on which bound tools a generation may use
 * (`modules/agents.md` — Active Tools). It was accepted, persisted and returned
 * but never applied, so every bound tool stayed callable (#811).
 *
 * A pure `lib/` test: the whole input space is a handful of list shapes, and
 * driving each through a real generation would cost an LLM round trip per case
 * while telling us less about which branch fired.
 */
describe('narrowToActiveTools', () => {
  const BOUND = ['tool_a', 'tool_b', 'tool_c'];

  test('restricts the bound set to the named tools', () => {
    expect(
      narrowToActiveTools({ toolIds: BOUND, activeToolIds: ['tool_a'] })
    ).toEqual(['tool_a']);
  });

  test('keeps the bound order and ignores names that are not bound', () => {
    expect(
      narrowToActiveTools({
        toolIds: BOUND,
        activeToolIds: ['tool_c', 'tool_a', 'tool_not_bound'],
      })
    ).toEqual(['tool_a', 'tool_c']);
  });

  test('treats null and an empty list as "no restriction"', () => {
    // An empty active set would leave the agent with no tools at all, which is
    // never a deliberate configuration — and agents stored `[]` while the field
    // was inert, so honouring it literally would silently disarm them.
    expect(
      narrowToActiveTools({ toolIds: BOUND, activeToolIds: null })
    ).toEqual(BOUND);
    expect(
      narrowToActiveTools({ toolIds: BOUND, activeToolIds: undefined })
    ).toEqual(BOUND);
    expect(narrowToActiveTools({ toolIds: BOUND, activeToolIds: [] })).toEqual(
      BOUND
    );
  });

  test('ignores a non-array value rather than dropping every tool', () => {
    // The column is untyped JSON, so a legacy or hand-written row can hold
    // anything; failing open here beats silently disarming a live agent.
    expect(
      narrowToActiveTools({ toolIds: BOUND, activeToolIds: 'tool_a' })
    ).toEqual(BOUND);
  });

  test('can narrow to nothing when every named tool is unbound', () => {
    expect(
      narrowToActiveTools({ toolIds: BOUND, activeToolIds: ['tool_zzz'] })
    ).toEqual([]);
  });
});
