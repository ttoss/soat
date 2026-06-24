import { DomainError } from 'src/errors';
import { runPipeline, validatePipelineConfig } from 'src/lib/pipelineTools';

// ── validatePipelineConfig ───────────────────────────────────────────────────

describe('validatePipelineConfig', () => {
  test('accepts a valid config and normalizes steps', () => {
    const config = validatePipelineConfig({
      steps: [
        {
          id: 'a',
          toolId: 'tool_a',
          action: 'add',
          input: { x: { var: 'input.n' } },
        },
        { id: 'b', toolId: 'tool_b', input: { y: { var: 'steps.a.sum' } } },
      ],
      output: { r: { var: 'steps.b.id' } },
    });
    expect(config.steps).toHaveLength(2);
    expect(config.steps[0]).toEqual({
      id: 'a',
      toolId: 'tool_a',
      action: 'add',
      input: { x: { var: 'input.n' } },
    });
    expect(config.output).toEqual({ r: { var: 'steps.b.id' } });
  });

  test('accepts a snake_case tool_id (formation template form)', () => {
    const config = validatePipelineConfig({
      steps: [{ id: 'a', tool_id: 'tool_x' }],
    });
    expect(config.steps[0].toolId).toBe('tool_x');
  });

  test('throws when pipeline is not an object', () => {
    expect(() => validatePipelineConfig(undefined)).toThrow(DomainError);
    expect(() => validatePipelineConfig('nope')).toThrow(/pipeline/i);
  });

  test('throws when steps is empty', () => {
    expect(() => validatePipelineConfig({ steps: [] })).toThrow(/non-empty/i);
  });

  test('throws on duplicate step id', () => {
    expect(() =>
      validatePipelineConfig({
        steps: [
          { id: 'a', toolId: 't1' },
          { id: 'a', toolId: 't2' },
        ],
      })
    ).toThrow(/duplicate/i);
  });

  test('throws on an invalid step id', () => {
    expect(() =>
      validatePipelineConfig({ steps: [{ id: 'a b', toolId: 't1' }] })
    ).toThrow(DomainError);
  });

  test('throws when a step is missing tool_id', () => {
    expect(() =>
      validatePipelineConfig({ steps: [{ id: 'a' }] })
    ).toThrow(/tool_id/i);
  });

  test('throws on a forward reference to a later step', () => {
    expect(() =>
      validatePipelineConfig({
        steps: [
          { id: 'a', toolId: 't1', input: { x: { var: 'steps.b.v' } } },
          { id: 'b', toolId: 't2' },
        ],
      })
    ).toThrow(/not an earlier step/i);
  });

  test('allows a backward reference to an earlier step', () => {
    expect(() =>
      validatePipelineConfig({
        steps: [
          { id: 'a', toolId: 't1' },
          { id: 'b', toolId: 't2', input: { x: { var: 'steps.a.v' } } },
        ],
      })
    ).not.toThrow();
  });

  test('throws when output is not an object', () => {
    expect(() =>
      validatePipelineConfig({
        steps: [{ id: 'a', toolId: 't1' }],
        output: 'nope',
      })
    ).toThrow(/output/i);
  });
});

// ── runPipeline ──────────────────────────────────────────────────────────────

describe('runPipeline', () => {
  test('runs steps in order, threading earlier outputs via JSON Logic', async () => {
    const calls: Array<{ toolId: string; input: Record<string, unknown> }> = [];
    const result = await runPipeline({
      pipeline: {
        steps: [
          { id: 'a', toolId: 'tool_a', input: { x: { var: 'input.n' } } },
          { id: 'b', toolId: 'tool_b', input: { y: { var: 'steps.a.value' } } },
        ],
      },
      input: { n: 5 },
      callStep: async (call) => {
        calls.push({ toolId: call.toolId, input: call.input });
        return call.toolId === 'tool_a' ? { value: 42 } : { done: true };
      },
    });

    expect(calls[0]).toEqual({ toolId: 'tool_a', input: { x: 5 } });
    expect(calls[1]).toEqual({ toolId: 'tool_b', input: { y: 42 } });
    // No output mapping → returns the last step's raw output.
    expect(result).toEqual({ done: true });
  });

  test('decrements remainingDepth for nested calls', async () => {
    let seenDepth: number | undefined;
    await runPipeline({
      pipeline: { steps: [{ id: 'a', toolId: 'tool_a' }] },
      remainingDepth: 3,
      callStep: async (call) => {
        seenDepth = call.remainingDepth;
        return {};
      },
    });
    expect(seenDepth).toBe(2);
  });

  test('resolves the output mapping over { input, steps }', async () => {
    const result = await runPipeline({
      pipeline: {
        steps: [{ id: 'a', toolId: 'tool_a' }],
        output: { total: { var: 'steps.a.sum' }, echo: { var: 'input.n' } },
      },
      input: { n: 7 },
      callStep: async () => {
        return { sum: 100 };
      },
    });
    expect(result).toEqual({ total: 100, echo: 7 });
  });

  test('merges presetParameters into the input context (caller wins on conflict)', async () => {
    let received: Record<string, unknown> | undefined;
    await runPipeline({
      pipeline: {
        steps: [
          {
            id: 'a',
            toolId: 'tool_a',
            input: {
              fromPreset: { var: 'input.preset' },
              overridden: { var: 'input.k' },
            },
          },
        ],
      },
      presetParameters: { preset: 'P', k: 'preset-value' },
      input: { k: 'caller-value' },
      callStep: async (call) => {
        received = call.input;
        return {};
      },
    });
    expect(received).toEqual({ fromPreset: 'P', overridden: 'caller-value' });
  });

  test('wraps a failing step as PIPELINE_STEP_FAILED and stops the sequence', async () => {
    const calls: string[] = [];
    let error: unknown;
    try {
      await runPipeline({
        pipeline: {
          steps: [
            { id: 'first', toolId: 'tool_a' },
            { id: 'second', toolId: 'tool_b' },
          ],
        },
        callStep: async (call) => {
          calls.push(call.toolId);
          if (call.toolId === 'tool_a') throw new Error('boom');
          return {};
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PIPELINE_STEP_FAILED');
    expect((error as DomainError).meta).toEqual({ step_id: 'first' });
    expect((error as DomainError).message).toMatch(/boom/);
    expect(calls).toEqual(['tool_a']);
  });

  test('throws PIPELINE_DEPTH_EXCEEDED when no depth remains', async () => {
    let error: unknown;
    try {
      await runPipeline({
        pipeline: { steps: [{ id: 'a', toolId: 'tool_a' }] },
        remainingDepth: 0,
        callStep: async () => {
          return {};
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PIPELINE_DEPTH_EXCEEDED');
  });
});
