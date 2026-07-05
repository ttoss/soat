import * as discussionCompletion from 'src/lib/discussionCompletion';
import {
  type DiscussionStep,
  resolveTemplate,
  runDiscussionPipeline,
} from 'src/lib/discussionEngine';

describe('discussionEngine', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockCompletion = (impl: (prompt: string) => string) => {
    return jest
      .spyOn(discussionCompletion, 'runDiscussionCompletion')
      .mockImplementation((args: { prompt: string }) => {
        return Promise.resolve(impl(args.prompt));
      });
  };

  describe('resolveTemplate', () => {
    test('substitutes topic, steps, steps.last, and transcript tokens', () => {
      const out = resolveTemplate({
        template:
          'topic={topic} full={steps.a} last={steps.a.last} t={transcript} unknown={nope}',
        topic: 'T',
        stepOutputs: { a: 'A1\nA2' },
        stepLastOutputs: { a: 'A2' },
        transcript: [{ name: 'X', text: 'hi' }],
      });
      expect(out).toBe('topic=T full=A1\nA2 last=A2 t=X: hi unknown={nope}');
    });
  });

  test('single implicit branch: the lone turn is the outcome', async () => {
    mockCompletion(() => {
      return 'lone answer';
    });
    const steps: DiscussionStep[] = [
      { name: 'only', prompt: 'Answer {topic}' },
    ];
    const outcome = await runDiscussionPipeline({
      projectId: 1,
      defaultAiProviderId: 'aip_x',
      steps,
      topic: 'Q',
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.reason).toBe('completed');
    expect(outcome.text).toBe('lone answer');
    expect(outcome.turns).toHaveLength(1);
  });

  test('multi-branch deliberation + synthesis output step', async () => {
    mockCompletion((prompt) => {
      if (prompt.includes('Synthesize')) return 'final synthesis';
      return prompt.includes('Advocate') ? 'for it' : 'against it';
    });
    const steps: DiscussionStep[] = [
      {
        name: 'deliberation',
        rounds: 2,
        branches: [
          { name: 'Advocate', prompt: 'Advocate: {topic}\n{transcript}' },
          { name: 'Skeptic', prompt: 'Skeptic: {topic}\n{transcript}' },
        ],
      },
      {
        name: 'synthesis',
        output: true,
        prompt: 'Synthesize: {steps.deliberation}',
      },
    ];
    const outcome = await runDiscussionPipeline({
      projectId: 1,
      defaultAiProviderId: 'aip_x',
      steps,
      topic: 'Q',
    });
    expect(outcome.text).toBe('final synthesis');
    expect(outcome.reason).toBe('completed');
    // 2 branches x 2 rounds + 1 synthesis
    expect(outcome.turns).toHaveLength(5);
  });

  test('all turns failing degrades to all_failed with empty text', async () => {
    jest
      .spyOn(discussionCompletion, 'runDiscussionCompletion')
      .mockRejectedValue(new Error('provider down'));
    const steps: DiscussionStep[] = [{ name: 'only', prompt: 'x' }];
    const outcome = await runDiscussionPipeline({
      projectId: 1,
      defaultAiProviderId: 'aip_x',
      steps,
      topic: 'Q',
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('all_failed');
    expect(outcome.text).toBe('');
    expect(outcome.dropped).toBeGreaterThan(0);
  });

  test('output step failing after a successful step degrades to output_failed', async () => {
    mockCompletion((prompt) => {
      if (prompt.includes('OUT')) throw new Error('output failed');
      return 'first ok';
    });
    const steps: DiscussionStep[] = [
      { name: 'first', prompt: 'first' },
      { name: 'out', prompt: 'OUT {steps.first}', output: true },
    ];
    const outcome = await runDiscussionPipeline({
      projectId: 1,
      defaultAiProviderId: 'aip_x',
      steps,
      topic: 'Q',
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('output_failed');
    // degrades to the last successful turn
    expect(outcome.text).toBe('first ok');
  });

  test('a non-output step producing nothing is skipped, later output still used', async () => {
    mockCompletion((prompt) => {
      if (prompt.includes('SKIP')) throw new Error('skip me');
      return 'final';
    });
    const steps: DiscussionStep[] = [
      { name: 'skipped', prompt: 'SKIP' },
      { name: 'final', prompt: 'final', output: true },
    ];
    const outcome = await runDiscussionPipeline({
      projectId: 1,
      defaultAiProviderId: 'aip_x',
      steps,
      topic: 'Q',
    });
    expect(outcome.reason).toBe('completed');
    expect(outcome.text).toBe('final');
  });
});
