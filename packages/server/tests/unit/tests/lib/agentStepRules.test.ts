/**
 * `step_rules` compilation — the pure half of the generation cluster: the
 * `tool_choice` normalization, the id→name plumbing, and the `prepareStep`
 * closure the AI SDK calls per step.
 *
 * Kept as a direct `lib/` test under the pure-algorithm keep-list
 * (`.claude/rules/tests.md`): the input space is `step_rules` × step number ×
 * key casing, and reaching a single branch through a generation would mean a
 * full project → provider → agent → tools fixture plus a stubbed provider call
 * per case, with the failure signal buried in a `generateText` argument.
 *
 * These cases were split across `agentGenerationHelpers.test.ts` and
 * `agentNonStreamGeneration.test.ts` while `buildPrepareStep` existed in both
 * modules; they cover one module now, so they live in one file (#911).
 */
import {
  buildPrepareStep,
  collectStepRuleActiveToolIds,
  normalizeToolChoice,
  resolveStepActiveTools,
} from 'src/lib/agentStepRules';

describe('normalizeToolChoice', () => {
  test('passes through the string strategies the AI SDK accepts', () => {
    expect(normalizeToolChoice('auto')).toBe('auto');
    expect(normalizeToolChoice('required')).toBe('required');
    expect(normalizeToolChoice('none')).toBe('none');
  });

  test('returns undefined for null, undefined, and unknown strings', () => {
    expect(normalizeToolChoice(null)).toBeUndefined();
    expect(normalizeToolChoice(undefined)).toBeUndefined();
    expect(normalizeToolChoice('sometimes')).toBeUndefined();
  });

  test('maps the wire-shaped object ({ tool_name }) to the AI SDK shape', () => {
    expect(
      normalizeToolChoice({ type: 'tool', tool_name: 'get_weather' })
    ).toEqual({ type: 'tool', toolName: 'get_weather' });
  });

  // The camelCase spellings were tolerated for rows written before the wire
  // shape worked. `backfillAgentStepRules` rewrote those rows, so a stored
  // camelCase key can no longer reach here and is no longer read.
  test('ignores the retired camelCase object ({ toolName })', () => {
    expect(
      normalizeToolChoice({ type: 'tool', toolName: 'get_weather' })
    ).toBeUndefined();
  });

  test('returns undefined for objects without a usable tool name', () => {
    expect(normalizeToolChoice({ type: 'tool' })).toBeUndefined();
    expect(normalizeToolChoice({ type: 'tool', tool_name: 7 })).toBeUndefined();
    expect(normalizeToolChoice({ type: 'other' })).toBeUndefined();
  });
});

describe('collectStepRuleActiveToolIds', () => {
  test('returns an empty array when stepRules is not an array', () => {
    expect(collectStepRuleActiveToolIds(null)).toEqual([]);
    expect(collectStepRuleActiveToolIds(undefined)).toEqual([]);
    expect(collectStepRuleActiveToolIds('nope')).toEqual([]);
  });

  test('collects and dedupes tool ids across rules', () => {
    const ids = collectStepRuleActiveToolIds([
      { step: 1, active_tool_ids: ['tool_a', 'tool_b'] },
      { step: 2, active_tool_ids: ['tool_b', 'tool_c'] },
      { step: 3, tool_choice: 'required' },
    ]);

    expect(ids.sort()).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  test('ignores the retired camelCase activeToolIds spelling', () => {
    expect(
      collectStepRuleActiveToolIds([{ step: 1, activeToolIds: ['tool_a'] }])
    ).toEqual([]);
  });
});

describe('resolveStepActiveTools', () => {
  test('returns undefined when activeToolIds is absent, empty, or not an array', () => {
    expect(
      resolveStepActiveTools({ activeToolIds: undefined, toolIdToName: {} })
    ).toBeUndefined();
    expect(
      resolveStepActiveTools({ activeToolIds: [], toolIdToName: {} })
    ).toBeUndefined();
    expect(
      resolveStepActiveTools({ activeToolIds: 'nope', toolIdToName: {} })
    ).toBeUndefined();
  });

  test('resolves ids to names via the map, dropping unresolvable ids', () => {
    expect(
      resolveStepActiveTools({
        activeToolIds: ['tool_a', 'tool_unknown'],
        toolIdToName: { tool_a: 'search' },
      })
    ).toEqual(['search']);
  });

  test('returns undefined when every id fails to resolve', () => {
    expect(
      resolveStepActiveTools({
        activeToolIds: ['tool_unknown'],
        toolIdToName: {},
      })
    ).toBeUndefined();
  });
});

describe('buildPrepareStep', () => {
  test('buildPrepareStep returns undefined when stepRules are empty', () => {
    const prepareStep = buildPrepareStep({
      stepRules: [],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeUndefined();
  });

  test('buildPrepareStep returns forced tool config for matching step', () => {
    const prepareStep = buildPrepareStep({
      stepRules: [
        { step: 2, tool_choice: { type: 'tool', tool_name: 'lookup' } },
      ],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 1 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'lookup' },
      activeTools: ['lookup'],
    });
    expect(prepareStep!({ stepNumber: 0 })).toEqual({});
  });

  test('buildPrepareStep ignores the retired camelCase rule keys', () => {
    const prepareStep = buildPrepareStep({
      stepRules: [
        {
          step: 1,
          toolChoice: { type: 'tool', toolName: 'lookup' },
          activeToolIds: ['tool_abc'],
        },
      ],
      logContext: 'non_stream',
      toolIdToName: { tool_abc: 'search' },
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 0 })).toEqual({});
  });

  test('buildPrepareStep honors a string tool_choice, not just a named tool', () => {
    // `tool_choice` accepts the strings "auto" / "required" / "none" as well as
    // the { type: "tool" } object, at the agent level and inside a step rule
    // alike. Forcing *some* tool call on the first step — without naming which
    // tool, because that varies per message — is the whole point of a rule like
    // { step: 1, tool_choice: "required" }: agent-level "required" applies to
    // every step and never lets the run stop, so the string form has to work
    // here or the rule is a silent no-op.
    const prepareStep = buildPrepareStep({
      stepRules: [{ step: 1, tool_choice: 'required' }],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeDefined();
    // Step 1 forces a tool call, and leaves the active tool set alone: no
    // specific tool is named, so every bound tool stays available.
    expect(prepareStep!({ stepNumber: 0 })).toEqual({ toolChoice: 'required' });
    // Later steps fall back to the agent's own tool_choice.
    expect(prepareStep!({ stepNumber: 1 })).toEqual({});
  });

  test('buildPrepareStep honors the wire-shaped (snake_case) step rule keys', () => {
    // step_rules are stored verbatim from the request body, and the wire is
    // snake_case: { step, tool_choice: { type, tool_name } } is the documented
    // shape (see docs/modules/agents.md#step-rules).
    const prepareStep = buildPrepareStep({
      stepRules: [
        { step: 2, tool_choice: { type: 'tool', tool_name: 'lookup' } },
      ],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 1 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'lookup' },
      activeTools: ['lookup'],
    });
  });

  test('buildPrepareStep restricts activeTools to a step rule active_tool_ids, resolved via id→name map', () => {
    // `active_tool_ids` on a step rule holds persisted tool ids
    // (`modules/agents.md` — Step Rules), while the AI SDK's `activeTools`
    // takes tool names — the caller resolves the id→name map (via
    // `resolveToolIdsToNames`) and hands it in here (#809).
    const prepareStep = buildPrepareStep({
      stepRules: [{ step: 1, active_tool_ids: ['tool_abc'] }],
      logContext: 'non_stream',
      toolIdToName: { tool_abc: 'search', tool_def: 'analyze' },
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 0 })).toEqual({
      activeTools: ['search'],
    });
    // A later step with no matching rule is untouched.
    expect(prepareStep!({ stepNumber: 1 })).toEqual({});
  });

  test('buildPrepareStep combines a forced tool_choice with a step rule active_tool_ids', () => {
    const prepareStep = buildPrepareStep({
      stepRules: [
        {
          step: 1,
          tool_choice: { type: 'tool', tool_name: 'search' },
          active_tool_ids: ['tool_abc', 'tool_def'],
        },
      ],
      logContext: 'non_stream',
      toolIdToName: { tool_abc: 'search', tool_def: 'analyze' },
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 0 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'search' },
      activeTools: ['search', 'analyze'],
    });
  });

  test('buildPrepareStep combines a string tool_choice override with active_tool_ids', () => {
    const prepareStep = buildPrepareStep({
      stepRules: [
        { step: 1, tool_choice: 'required', active_tool_ids: ['tool_abc'] },
      ],
      logContext: 'non_stream',
      toolIdToName: { tool_abc: 'search' },
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 0 })).toEqual({
      toolChoice: 'required',
      activeTools: ['search'],
    });
  });

  test('buildPrepareStep ignores active_tool_ids that resolve to no known tool', () => {
    const prepareStep = buildPrepareStep({
      stepRules: [{ step: 1, active_tool_ids: ['tool_doesNotExist'] }],
      logContext: 'non_stream',
      toolIdToName: {},
    });

    expect(prepareStep).toBeDefined();
    // No id resolved to a name — treated as no restriction, not "no tools".
    expect(prepareStep!({ stepNumber: 0 })).toEqual({});
  });
});
