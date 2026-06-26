/**
 * Direct unit tests for the reasoning pipeline runner. The reasoning primitive
 * (`runReasoningCompletion`) is spied; no traceId/projectId is passed so no
 * child generation records hit the DB — the wiring tests cover that path.
 */
import * as reasoningCompletionModule from 'src/lib/reasoningCompletion';
import {
  formatQuestion,
  resolveTemplate,
  runReasoningPipeline,
} from 'src/lib/reasoningPipeline';

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
  test('replaces question, draft, and step tokens; leaves unknowns', () => {
    expect(
      resolveTemplate({
        template: 'Q: {question}\nD: {draft}\nS: {steps.a}\nU: {nope}',
        question: 'the question',
        draft: 'the draft',
        stepOutputs: { a: 'the step output' },
      })
    ).toBe('Q: the question\nD: the draft\nS: the step output\nU: {nope}');
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
  test('runs a linear two-step pipeline and returns the output step text', async () => {
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

  test('halt_if_equals stops the pipeline and keeps the draft', async () => {
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

  test('fanout runs count×rounds and accumulates a transcript', async () => {
    mockRun
      .mockResolvedValueOnce('view A')
      .mockResolvedValueOnce('view B')
      .mockResolvedValueOnce('synthesis');

    const outcome = await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          kind: 'fanout',
          name: 'angles',
          count: 2,
          prompt: 'Angle: {question}',
        },
        { name: 'final', prompt: 'Reconcile {steps.angles}', output: true },
      ],
    });

    expect(outcome.text).toBe('synthesis');
    expect(outcome.stepsRun).toBe(3);
    // The second perspective sees the first; synthesis sees both.
    expect(mockRun.mock.calls[1][0].prompt).toContain('view A');
    expect(mockRun.mock.calls[2][0].prompt).toContain('view A');
    expect(mockRun.mock.calls[2][0].prompt).toContain('view B');
  });

  test('forwards per-step model and provider overrides', async () => {
    mockRun.mockResolvedValueOnce('out');

    await runReasoningPipeline({
      ...baseArgs,
      steps: [
        {
          name: 'only',
          prompt: 'p',
          model: 'm1',
          aiProviderId: 'aip_1',
          output: true,
        },
      ],
    });

    expect(mockRun.mock.calls[0][0]).toMatchObject({
      model: 'm1',
      aiProviderId: 'aip_1',
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
});
