/**
 * Direct unit tests for the reasoning pipeline runner. The reasoning primitive
 * (`runReasoningCompletion`) is spied; no traceId/projectId is passed so no
 * child generation records hit the DB — the wiring tests cover that path.
 */
import * as eventBus from 'src/lib/eventBus';
import { MAX_TOTAL_COMPLETIONS } from 'src/lib/reasoning';
import * as reasoningCompletionModule from 'src/lib/reasoningCompletion';
import {
  formatQuestion,
  resolveTemplate,
  runReasoningPipeline,
} from 'src/lib/reasoningPipeline';
import { applyReasoningPipeline } from 'src/lib/reasoningPipelineHook';

const mockRun = jest.spyOn(reasoningCompletionModule, 'runReasoningCompletion');

const baseArgs = {
  agentId: 'agent_1',
  question: 'What is X?',
  draft: 'draft answer',
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('resolveTemplate', () => {
  test('replaces question, draft, step, and transcript tokens; leaves unknowns', () => {
    expect(
      resolveTemplate({
        template:
          'Q: {question}\nD: {draft}\nS: {steps.a}\nL: {steps.a.last}\nT: {transcript}\nU: {nope}',
        question: 'the question',
        draft: 'the draft',
        stepOutputs: { a: 'the step output' },
        stepLastOutputs: { a: 'the last turn' },
        transcript: [{ name: 'X', text: 'x said this' }],
      })
    ).toBe(
      'Q: the question\nD: the draft\nS: the step output\nL: the last turn\nT: X: x said this\nU: {nope}'
    );
  });

  test('unresolved step and transcript references fall back to empty string', () => {
    expect(
      resolveTemplate({
        template: '{steps.missing} {steps.missing.last} {transcript}',
        question: 'q',
        draft: 'd',
        stepOutputs: {},
      })
    ).toBe('  ');
  });
});

describe('formatQuestion', () => {
  test('joins plain-text user/assistant turns and drops the rest', () => {
    expect(
      formatQuestion([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: { type: 'tool_output' } },
      ])
    ).toBe('user: hi\nassistant: hello');
  });
});

describe('runReasoningPipeline', () => {
  test('runs a linear two single-branch-step pipeline and returns the output step text', async () => {
    mockRun
      .mockResolvedValueOnce('the critique')
      .mockResolvedValueOnce('final answer');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        { name: 'critique', prompt: 'Critique: {draft}' },
        {
          name: 'final',
          prompt: 'Improve using {steps.critique}',
          output: true,
        },
      ],
    });

    expect(outcome).toMatchObject({
      text: 'final answer',
      applied: true,
      reason: 'completed',
      stepsRun: 2,
    });
    // The final step prompt was resolved with the critique output.
    expect(mockRun.mock.calls[1][0].prompt).toContain('the critique');
  });

  test('defaults the output to the last step when none is flagged', async () => {
    mockRun.mockResolvedValueOnce('a').mockResolvedValueOnce('b');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        { name: 'a', prompt: 'p' },
        { name: 'b', prompt: 'q' },
      ],
    });

    expect(outcome.text).toBe('b');
    expect(outcome.applied).toBe(true);
  });

  test('haltIfEquals stops the pipeline and keeps the draft', async () => {
    mockRun.mockResolvedValueOnce('APPROVED');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        { name: 'critique', prompt: 'Critique', haltIfEquals: 'APPROVED' },
        { name: 'final', prompt: 'Improve', output: true },
      ],
    });

    expect(outcome).toMatchObject({
      text: 'draft answer',
      applied: false,
      reason: 'halted',
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  test('independent branches (no {transcript}) do not see each other', async () => {
    mockRun
      .mockResolvedValueOnce('view A')
      .mockResolvedValueOnce('view B')
      .mockResolvedValueOnce('synthesis');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          name: 'angles',
          branches: [{ name: 'A' }, { name: 'B' }],
          prompt: 'Angle: {question}',
        },
        { name: 'final', prompt: 'Reconcile {steps.angles}', output: true },
      ],
    });

    expect(outcome.text).toBe('synthesis');
    expect(outcome.stepsRun).toBe(3);
    // Branch B's prompt has no {transcript} token, so it never sees A's output.
    expect(mockRun.mock.calls[1][0].prompt).not.toContain('view A');
    // The synthesis step reads the concatenated transcript via {steps.angles}.
    expect(mockRun.mock.calls[2][0].prompt).toContain('view A');
    expect(mockRun.mock.calls[2][0].prompt).toContain('view B');
  });

  test('a shared-transcript debate step runs branches sequentially across rounds', async () => {
    mockRun
      .mockResolvedValueOnce('opt round 1')
      .mockResolvedValueOnce('skep round 1')
      .mockResolvedValueOnce('opt round 2')
      .mockResolvedValueOnce('skep round 2')
      .mockResolvedValueOnce('synthesis');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          name: 'debate',
          rounds: 2,
          branches: [
            { name: 'Optimist', prompt: 'Argue for. {transcript}' },
            { name: 'Skeptic', prompt: 'Argue against. {transcript}' },
          ],
        },
        { name: 'final', prompt: 'Synthesize {steps.debate}', output: true },
      ],
    });

    expect(outcome.text).toBe('synthesis');
    expect(outcome.stepsRun).toBe(5);
    // Skeptic round 1 sees the Optimist's round-1 turn via {transcript}.
    expect(mockRun.mock.calls[1][0].prompt).toContain('opt round 1');
    // Optimist round 2 sees both round-1 turns.
    expect(mockRun.mock.calls[2][0].prompt).toContain('opt round 1');
    expect(mockRun.mock.calls[2][0].prompt).toContain('skep round 1');
  });

  test('{steps.x.last} exposes only the final turn of a shared-transcript step', async () => {
    mockRun
      .mockResolvedValueOnce('opt round 1')
      .mockResolvedValueOnce('skep round 1')
      .mockResolvedValueOnce('final skeptic turn');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          name: 'debate',
          rounds: 1,
          branches: [
            { name: 'Optimist', prompt: 'Argue for. {transcript}' },
            { name: 'Skeptic', prompt: 'Argue against. {transcript}' },
          ],
        },
        {
          name: 'final',
          prompt: 'Verdict based on {steps.debate.last}',
          output: true,
        },
      ],
    });

    expect(outcome.text).toBe('final skeptic turn');
    expect(mockRun.mock.calls[2][0].prompt).toBe(
      'Verdict based on skep round 1'
    );
    expect(mockRun.mock.calls[2][0].prompt).not.toContain('opt round 1');
  });

  test('forwards per-step and per-branch model/provider/temperature overrides', async () => {
    mockRun.mockResolvedValueOnce('out').mockResolvedValueOnce('out2');

    await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          name: 'only',
          prompt: 'p',
          model: 'step-model',
          aiProviderId: 'aip_step',
          temperature: 0.3,
        },
        {
          name: 'branched',
          branches: [
            {
              name: 'A',
              prompt: 'p',
              model: 'branch-model',
              aiProviderId: 'aip_branch',
              temperature: 0.9,
            },
          ],
          output: true,
        },
      ],
    });

    expect(mockRun.mock.calls[0][0]).toMatchObject({
      model: 'step-model',
      aiProviderId: 'aip_step',
      temperature: 0.3,
    });
    expect(mockRun.mock.calls[1][0]).toMatchObject({
      model: 'branch-model',
      aiProviderId: 'aip_branch',
      temperature: 0.9,
    });
  });

  test('falls back to the draft when the output step fails', async () => {
    mockRun.mockRejectedValueOnce(new Error('provider down'));

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [{ name: 'final', prompt: 'p', output: true }],
    });

    expect(outcome).toMatchObject({
      text: 'draft answer',
      applied: false,
      reason: 'output_failed',
    });
  });

  test('drops a failed non-output step but still produces the final answer', async () => {
    mockRun
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce('final');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        { name: 'a', prompt: 'p' },
        { name: 'final', prompt: 'q', output: true },
      ],
    });

    expect(outcome).toMatchObject({
      text: 'final',
      applied: true,
      reason: 'completed',
      dropped: 1,
    });
  });

  test('drops a failed branch within a multi-branch step but keeps the rest', async () => {
    mockRun
      .mockResolvedValueOnce('view A')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce('synthesis');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          name: 'angles',
          branches: [{ name: 'A' }, { name: 'B' }],
          prompt: 'Angle: {question}',
        },
        { name: 'final', prompt: 'Reconcile {steps.angles}', output: true },
      ],
    });

    expect(outcome).toMatchObject({
      text: 'synthesis',
      applied: true,
      reason: 'completed',
      dropped: 1,
    });
  });

  test('never launches more than the total completion budget', async () => {
    mockRun.mockResolvedValue('x');

    // Eight steps × 5 branches × 3 rounds = 120 potential completions, far above the cap.
    const steps = Array.from({ length: 8 }, (_unused, i) => {
      return {
        name: `s${i}`,
        prompt: 'Angle: {question} {transcript}',
        branches: Array.from({ length: 5 }, (_unusedB, j) => {
          return { name: `b${j}`, prompt: 'Angle: {question} {transcript}' };
        }),
        rounds: 3,
      };
    });

    await runReasoningPipeline({ ...baseArgs, steps });

    expect(mockRun.mock.calls.length).toBeLessThanOrEqual(
      MAX_TOTAL_COMPLETIONS
    );
  });
});

describe('applyReasoningPipeline legacy-mode signal', () => {
  test('emits a fallback event for an inert legacy mode and runs no completions', async () => {
    const emit = jest.spyOn(eventBus, 'emitEvent').mockImplementation(() => {
      return undefined;
    });

    // A stored agent from before the pipeline migration.
    const legacyConfig = { mode: 'reflect' } as never;

    await applyReasoningPipeline({
      reasoningConfig: legacyConfig,
      agentId: 'agent_1',
      generationId: 'gen_1',
      projectId: 1,
      projectPublicId: 'prj_1',
      messages: [],
      result: { text: 'draft answer' },
    });

    expect(mockRun).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agents.reasoning.fallback' })
    );
  });
});
