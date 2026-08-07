import { findTextEncodedToolCall } from 'src/lib/textEncodedToolCall';

// A pure function over a large input space (every shape a model may improvise
// when it narrates a tool call instead of making one, against every shape of
// ordinary answer that must survive untouched), so it earns a direct lib test
// under the keep-list: driving one case through a generation would need a
// project + provider + agent + a stub response each time, and the signal — a
// generation that completed instead of failing — would not say which shape
// slipped through.
//
// The wiring — that a generation actually consults this, and fails instead of
// completing — is covered at the entry point, in
// `rest/agentGeneration.test.ts`.
describe('findTextEncodedToolCall', () => {
  const toolNames = ['get-fundamental-truth', 'search-web'];

  const find = (text: string) => {
    return findTextEncodedToolCall({ text, toolNames });
  };

  // The confirmed failing generation, verbatim: grok-4.5 on xai.responses
  // finished with `stop`, one step, no tool-call part, and this as its text.
  test('detects the reported fenced blob', () => {
    expect(
      find('```json\n{"name": "get-fundamental-truth", "arguments": {}}\n```')
    ).toBe('get-fundamental-truth');
  });

  test('detects it unfenced, and with a plain fence', () => {
    expect(find('{"name": "get-fundamental-truth", "arguments": {}}')).toBe(
      'get-fundamental-truth'
    );
    expect(
      find('```\n{"name": "search-web", "arguments": {"q": "x"}}\n```')
    ).toBe('search-web');
  });

  test('detects the improvised key spellings', () => {
    expect(find('{"tool": "search-web", "args": {"q": "x"}}')).toBe(
      'search-web'
    );
    expect(find('{"tool_name": "search-web", "parameters": {}}')).toBe(
      'search-web'
    );
    expect(find('{"name": "search-web", "input": {}}')).toBe('search-web');
  });

  test('detects a call with no arguments key at all', () => {
    expect(find('{"name": "get-fundamental-truth"}')).toBe(
      'get-fundamental-truth'
    );
  });

  test('detects an array in which every element is a call', () => {
    expect(
      find('[{"name": "search-web", "arguments": {}}, {"name": "search-web"}]')
    ).toBe('search-web');
  });

  test('leaves an array alone when only some elements are calls', () => {
    expect(
      find('[{"name": "search-web"}, {"title": "a real list item"}]')
    ).toBeNull();
  });

  // Everything below is an answer that must still complete. A false positive
  // fails a generation that was fine, which is why the detector is narrow.
  test('leaves ordinary prose alone', () => {
    expect(
      find('The fundamental truth is that the plant was never watered.')
    ).toBeNull();
    expect(find('')).toBeNull();
  });

  test('leaves prose that merely mentions a tool alone', () => {
    expect(
      find('I will call get-fundamental-truth with {"arguments": {}} next.')
    ).toBeNull();
  });

  test('leaves a JSON answer carrying keys outside tool-call vocabulary alone', () => {
    expect(
      find('{"name": "get-fundamental-truth", "summary": "a real answer"}')
    ).toBeNull();
    expect(find('{"title": "A casa arrumada", "text": "…"}')).toBeNull();
  });

  test('leaves a call naming a tool the agent does not have alone', () => {
    expect(find('{"name": "some-other-tool", "arguments": {}}')).toBeNull();
  });

  test('leaves everything alone when the agent has no tools', () => {
    expect(
      findTextEncodedToolCall({
        text: '{"name": "get-fundamental-truth", "arguments": {}}',
        toolNames: [],
      })
    ).toBeNull();
  });

  test('leaves malformed JSON and non-object JSON alone', () => {
    expect(find('{"name": "get-fundamental-truth", ')).toBeNull();
    expect(find('"get-fundamental-truth"')).toBeNull();
    expect(find('[]')).toBeNull();
    expect(find('{}')).toBeNull();
    expect(find('[{}]')).toBeNull();
  });
});
