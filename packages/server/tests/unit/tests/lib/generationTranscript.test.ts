import { projectTranscriptSteps } from 'src/lib/generationTranscript';

/**
 * The stored step → transcript step projection.
 *
 * Tested directly (keep-list rule 1): the input space is the AI SDK's
 * serialized step format, and driving one shape through REST costs a whole
 * agent run whose failure signal would be an empty `steps` array — which says
 * nothing about which shape was mishandled. The endpoint's happy path is
 * pinned end-to-end in `rest/generationTranscript.test.ts`.
 *
 * The shapes below are the ones `ai@7` actually writes to disk, read off
 * `DefaultStepResult` in the installed package rather than off the type
 * declarations: every field the class defines as a **getter** — `text`,
 * `toolCalls`, `toolResults`, `reasoning`, `files`, `sources` — lives on the
 * prototype, so `JSON.stringify` in `serializeSteps` drops it. Only the
 * constructor-assigned own properties survive: `content`, `finishReason`,
 * `usage`, `stepNumber`, `model`, and friends.
 */
describe('projectTranscriptSteps', () => {
  const usage = {
    inputTokens: 412,
    outputTokens: 22,
    totalTokens: 434,
    inputTokenDetails: { cacheReadTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 },
  };

  test('projects a tool-calling step from its content parts', () => {
    const steps = [
      {
        stepNumber: 0,
        finishReason: 'tool-calls',
        usage,
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { cityName: 'Paris' },
          },
        ],
      },
    ];

    expect(projectTranscriptSteps(steps)).toEqual([
      {
        index: 0,
        text: '',
        finish_reason: 'tool-calls',
        tool_calls: [
          {
            id: 'call_1',
            tool_name: 'get_weather',
            args: { cityName: 'Paris' },
          },
        ],
        tool_results: [],
        usage: { input_tokens: 412, output_tokens: 22, total_tokens: 434 },
      },
    ]);
  });

  test('projects a tool-result part, reading `output` not `result`', () => {
    // ai@7 names the payload `output`; v4 named it `result`. A projection
    // written from the PRD's v4-shaped example returns undefined here.
    const steps = [
      {
        finishReason: 'tool-calls',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { cityName: 'Paris' },
            output: { tempC: 18 },
          },
        ],
      },
    ];

    expect(projectTranscriptSteps(steps)[0].tool_results).toEqual([
      {
        tool_call_id: 'call_1',
        tool_name: 'get_weather',
        result: { tempC: 18 },
        error: null,
      },
    ]);
  });

  test('projects a tool-error part as a failed result', () => {
    const steps = [
      {
        finishReason: 'tool-calls',
        content: [
          {
            type: 'tool-error',
            toolCallId: 'call_9',
            toolName: 'get_weather',
            input: { cityName: 'Nowhere' },
            error: { name: 'HttpToolError', message: 'upstream 502' },
          },
        ],
      },
    ];

    expect(projectTranscriptSteps(steps)[0].tool_results).toEqual([
      {
        tool_call_id: 'call_9',
        tool_name: 'get_weather',
        result: null,
        error: { name: 'HttpToolError', message: 'upstream 502' },
      },
    ]);
  });

  test('ignores the getter-backed fields a stored step never carries', () => {
    // The #1012 failure mode, as a regression guard. `text`, `toolCalls` and
    // `toolResults` are prototype getters on DefaultStepResult, so they are
    // absent from every real trace on disk. A projection that reads them
    // typechecks, passes against live SDK objects, and returns nothing for
    // every stored trace — so reading them here must have no effect.
    const steps = [
      {
        finishReason: 'stop',
        text: 'from a getter',
        toolCalls: [{ toolCallId: 'ghost', toolName: 'ghost', input: {} }],
        toolResults: [{ toolCallId: 'ghost', toolName: 'ghost', output: {} }],
        content: [{ type: 'text', text: 'the real text' }],
      },
    ];

    const [step] = projectTranscriptSteps(steps);
    expect(step.text).toBe('the real text');
    expect(step.tool_calls).toEqual([]);
    expect(step.tool_results).toEqual([]);
  });

  test('joins multiple text parts and keeps non-text parts out of `text`', () => {
    const steps = [
      {
        finishReason: 'stop',
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'reasoning', text: 'hidden reasoning' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    ];

    expect(projectTranscriptSteps(steps)[0].text).toBe('Part one. Part two.');
  });

  test('indexes steps by position, not by the stored stepNumber', () => {
    // A resumed turn concatenates the pre-pause steps with the continuation's
    // (`runCompletionSideEffects` does `[...prevSteps, ...newSteps]`), and the
    // continuation's own numbering restarts at 0 — so stepNumber repeats within
    // one stored array. Position is the only monotonic index.
    const steps = [
      { stepNumber: 0, finishReason: 'tool-calls', content: [] },
      { stepNumber: 0, finishReason: 'stop', content: [] },
    ];

    expect(
      projectTranscriptSteps(steps).map((step) => {
        return step.index;
      })
    ).toEqual([0, 1]);
  });

  test('copies args and results as opaque values', () => {
    // Caller- and tool-owned payloads: inner keys are never inspected or
    // rewritten (.claude/rules/case-convention.md).
    const args = { city_name: 'Paris', nested: { max_daily_budget: 10 } };
    const output = { temp_c: 18, StringEquals: 'kept' };
    const steps = [
      {
        finishReason: 'tool-calls',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: args },
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 't',
            output,
          },
        ],
      },
    ];

    const [step] = projectTranscriptSteps(steps);
    expect(step.tool_calls[0].args).toEqual(args);
    expect(step.tool_results[0].result).toEqual(output);
  });

  test('reports usage as null when the step carries none', () => {
    const steps = [{ finishReason: 'stop', content: [] }];
    expect(projectTranscriptSteps(steps)[0].usage).toBeNull();
  });

  test('defaults missing token counts to null rather than 0', () => {
    // A provider that omits a breakdown must not read as "used no tokens".
    const steps = [
      {
        finishReason: 'stop',
        content: [],
        usage: { inputTokens: 10, outputTokens: undefined },
      },
    ];

    expect(projectTranscriptSteps(steps)[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: null,
      total_tokens: null,
    });
  });

  test('projects a step that is not an object as an empty step', () => {
    // Read back from storage, so the shape is not a guarantee the type system
    // can make. A step that is not an object carries nothing to report, but it
    // still occupies its position — dropping it would renumber every step after
    // it and break correlation with `step_count`.
    const projected = projectTranscriptSteps([
      null,
      'a string',
      7,
      { content: 'not an array' },
    ]);

    expect(projected).toHaveLength(4);
    for (const step of projected) {
      expect(step.text).toBe('');
      expect(step.tool_calls).toEqual([]);
      expect(step.tool_results).toEqual([]);
      expect(step.finish_reason).toBeNull();
    }
  });

  test('reports a malformed part with nulls rather than dropping it', () => {
    // A tool-call part with no id and no name cannot be correlated to a result,
    // but it did happen. On a debugging surface, under-reporting the number of
    // tool calls is worse than reporting one whose details are unavailable —
    // the nulls say exactly what is missing, a dropped entry says nothing.
    const projected = projectTranscriptSteps([
      { content: [null, { type: 'text' }, { type: 'tool-call' }] },
    ]);

    expect(projected[0].text).toBe('');
    expect(projected[0].tool_calls).toEqual([
      { id: null, tool_name: null, args: null },
    ]);
  });

  test('returns an empty array when the steps object is missing or corrupt', () => {
    // What a purged, never-written, or unparseable steps object resolves to.
    expect(projectTranscriptSteps(null)).toEqual([]);
    expect(projectTranscriptSteps(undefined)).toEqual([]);
    expect(projectTranscriptSteps({ steps: [] })).toEqual([]);
    expect(projectTranscriptSteps([])).toEqual([]);
  });
});
