import { deriveTurnOutputText } from 'src/lib/generationTurn';

/**
 * The reference answer a curated dataset item inherits, derived from a trace's
 * **serialized** steps.
 *
 * Tested directly (keep-list rule 1): the input space is the AI SDK's step
 * format, and reaching one shape through REST costs a whole agent run whose
 * failure signal would be a bare `expected_output: null` — which says nothing
 * about which shape was mishandled. The happy path is still pinned end-to-end in
 * `rest/datasetItemsFromGeneration.test.ts`.
 */
describe('deriveTurnOutputText', () => {
  const textStep = (...texts: string[]) => {
    return {
      content: texts.map((text) => {
        return { type: 'text', text };
      }),
    };
  };

  test("reads the text out of a step's content parts", () => {
    expect(
      deriveTurnOutputText([textStep('On the first of each month.')])
    ).toBe('On the first of each month.');
  });

  test('ignores a top-level `text` field, which serialization never produces', () => {
    // `StepResult.text` is a getter over `content`, and `serializeSteps` goes
    // through JSON.stringify — so a stored step has `content` and no `text`.
    // Reading `text` here would pass against live SDK objects and return null
    // for every real trace on disk.
    expect(deriveTurnOutputText([{ text: 'from a getter' }])).toBeNull();
  });

  test('joins multiple text parts of the same step', () => {
    expect(deriveTurnOutputText([textStep('Part one. ', 'Part two.')])).toBe(
      'Part one. Part two.'
    );
  });

  test('skips non-text parts', () => {
    const step = {
      content: [
        { type: 'tool-call', toolName: 'get_weather', input: {} },
        { type: 'text', text: 'It is sunny.' },
        { type: 'reasoning', text: 42 },
      ],
    };
    expect(deriveTurnOutputText([step])).toBe('It is sunny.');
  });

  test('returns the last step that produced text, not the last step', () => {
    // A run can stop on a tool call — a max_steps cutoff, or a stop condition
    // firing after a tool result. The answer worth keeping is the one before it.
    const toolOnlyStep = {
      content: [{ type: 'tool-call', toolName: 'lookup', input: {} }],
    };
    expect(
      deriveTurnOutputText([textStep('Earlier answer.'), toolOnlyStep])
    ).toBe('Earlier answer.');
  });

  test('returns null when no step produced text', () => {
    expect(deriveTurnOutputText([{ content: [] }])).toBeNull();
    expect(deriveTurnOutputText([textStep('   ')])).toBeNull();
    expect(deriveTurnOutputText([])).toBeNull();
  });

  test('tolerates steps that are not shaped as expected', () => {
    // The steps object is read back from storage, so its shape is not a
    // guarantee the type system can make.
    expect(deriveTurnOutputText([null, 'a string', 7])).toBeNull();
    expect(deriveTurnOutputText([{ content: 'not an array' }])).toBeNull();
    expect(
      deriveTurnOutputText([{ content: [null, { type: 'text' }] }])
    ).toBeNull();
  });

  test('returns null when the steps object is not an array at all', () => {
    // What a missing, purged, or corrupt steps object resolves to.
    expect(deriveTurnOutputText(null)).toBeNull();
    expect(deriveTurnOutputText(undefined)).toBeNull();
    expect(deriveTurnOutputText({ steps: [] })).toBeNull();
  });
});
