import {
  maybeApplyDebateToResult,
  runDebate,
} from 'src/lib/deliberation';
import * as reasoningCompletionModule from 'src/lib/reasoningCompletion';

const mockRunReasoningCompletion = jest.spyOn(
  reasoningCompletionModule,
  'runReasoningCompletion'
);

describe('deliberation lib', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('runDebate', () => {
    const baseArgs = {
      agentId: 'agent_debate01',
      projectIds: [1],
      messages: [
        { role: 'user', content: 'Should we invest in this project?' },
      ],
      temperature: null,
    };

    test('integer perspectives generates auto-persona turns then synthesizes', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('Advocate: strong upside.')
        .mockResolvedValueOnce('Skeptic: risks outweigh benefits.')
        .mockResolvedValueOnce('Pragmatist: phased approach recommended.')
        .mockResolvedValueOnce('Synthesized: proceed with phased investment.');

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 3 },
      });

      expect(result.applied).toBe(true);
      expect(result.text).toBe('Synthesized: proceed with phased investment.');
      expect(result.reason).toBe('synthesized');
      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(4);
    });

    test('auto-persona names appear in the perspective prompts', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2 },
      });

      const firstCall = mockRunReasoningCompletion.mock.calls[0][0];
      const secondCall = mockRunReasoningCompletion.mock.calls[1][0];
      expect(firstCall.prompt).toContain('Advocate');
      expect(secondCall.prompt).toContain('Skeptic');
      expect(firstCall.prompt).toContain(
        'Should we invest in this project?'
      );
    });

    test('later perspective turns see earlier turns in the transcript', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2 },
      });

      const skepticCall = mockRunReasoningCompletion.mock.calls[1][0];
      expect(skepticCall.prompt).toContain('advocate text');
    });

    test('explicit perspective objects: names and custom prompts are used', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('critic response')
        .mockResolvedValueOnce('builder response')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        ...baseArgs,
        reasoning: {
          mode: 'debate',
          perspectives: [
            { name: 'Critic', prompt: 'Attack the weakest point.' },
            { name: 'Builder', prompt: 'Steelman the proposal.' },
          ],
        },
      });

      const criticCall = mockRunReasoningCompletion.mock.calls[0][0];
      expect(criticCall.prompt).toContain('Critic');
      expect(criticCall.prompt).toContain('Attack the weakest point.');
    });

    test('per-perspective aiProviderId and model are forwarded to the completion call', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('expert text')
        .mockResolvedValueOnce('critic text')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        ...baseArgs,
        reasoning: {
          mode: 'debate',
          perspectives: [
            {
              name: 'Expert',
              aiProviderId: 'aip_expert',
              model: 'expert-model',
            },
            { name: 'Critic' },
          ],
        },
      });

      const expertCall = mockRunReasoningCompletion.mock.calls[0][0];
      expect(expertCall.aiProviderId).toBe('aip_expert');
      expect(expertCall.model).toBe('expert-model');

      const criticCall = mockRunReasoningCompletion.mock.calls[1][0];
      expect(criticCall.aiProviderId).toBeUndefined();
      expect(criticCall.model).toBeUndefined();
    });

    test('synthesis override triple is forwarded to the synthesis call', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('perspective 1')
        .mockResolvedValueOnce('perspective 2')
        .mockResolvedValueOnce('synthesized answer');

      await runDebate({
        ...baseArgs,
        reasoning: {
          mode: 'debate',
          perspectives: 2,
          synthesis: {
            aiProviderId: 'aip_flagship',
            model: 'flagship-model',
          },
        },
      });

      const synthCall =
        mockRunReasoningCompletion.mock.calls[2][0];
      expect(synthCall.aiProviderId).toBe('aip_flagship');
      expect(synthCall.model).toBe('flagship-model');
    });

    test('synthesis prompt includes the full transcript', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis result');

      await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2 },
      });

      const synthCall =
        mockRunReasoningCompletion.mock.calls[2][0];
      expect(synthCall.prompt).toContain('advocate text');
      expect(synthCall.prompt).toContain('skeptic text');
    });

    test('maxRounds > 1: each perspective runs for each round', async () => {
      // 2 perspectives × 2 rounds = 4 calls + 1 synthesis = 5 total
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate r1')
        .mockResolvedValueOnce('skeptic r1')
        .mockResolvedValueOnce('advocate r2')
        .mockResolvedValueOnce('skeptic r2')
        .mockResolvedValueOnce('synthesis after 2 rounds');

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2, maxRounds: 2 },
      });

      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(5);
      expect(result.applied).toBe(true);
      expect(result.text).toBe('synthesis after 2 rounds');
    });

    test('round 2 perspective prompts contain round 1 turns', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate r1')
        .mockResolvedValueOnce('skeptic r1')
        .mockResolvedValueOnce('advocate r2')
        .mockResolvedValueOnce('skeptic r2')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2, maxRounds: 2 },
      });

      // round 2 advocate call (index 2) should see round 1 turns
      const r2AdvocateCall = mockRunReasoningCompletion.mock.calls[2][0];
      expect(r2AdvocateCall.prompt).toContain('advocate r1');
      expect(r2AdvocateCall.prompt).toContain('skeptic r1');
    });

    test('maxRounds is capped at 3', async () => {
      // 2 perspectives × 3 rounds (capped from 10) = 6 + 1 synthesis = 7
      for (let i = 0; i < 7; i++) {
        mockRunReasoningCompletion.mockResolvedValueOnce(`text ${i}`);
      }

      await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2, maxRounds: 10 },
      });

      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(7);
    });

    test('a failing perspective is dropped and quorum continues', async () => {
      mockRunReasoningCompletion
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValueOnce('skeptic succeeds')
        .mockResolvedValueOnce('pragmatist succeeds')
        .mockResolvedValueOnce('synthesized from 2');

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 3 },
      });

      expect(result.applied).toBe(true);
      expect(result.text).toBe('synthesized from 2');
      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(4);
    });

    test('all perspectives fail → fallback without calling synthesis', async () => {
      mockRunReasoningCompletion
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'));

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 3 },
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('fallback');
      // synthesis should not be called
      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(3);
    });

    test('synthesis failure → synthesis_failed fallback', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('perspective 1')
        .mockResolvedValueOnce('perspective 2')
        .mockRejectedValueOnce(new Error('synthesis provider down'));

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2 },
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('synthesis_failed');
    });

    test('returns skipped when mode is not debate', async () => {
      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'reflect' },
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('skipped');
      expect(mockRunReasoningCompletion).not.toHaveBeenCalled();
    });
  });

  describe('maybeApplyDebateToResult', () => {
    test('mutates result.text with synthesized answer and clears response messages', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('p1')
        .mockResolvedValueOnce('p2')
        .mockResolvedValueOnce('debate synthesis');

      const result = {
        text: 'original draft',
        response: { messages: [{ role: 'assistant' }] as unknown[] },
      };

      await maybeApplyDebateToResult({
        reasoningConfig: { mode: 'debate', perspectives: 2 },
        agentId: 'agent_test',
        generationId: 'gen_test',
        messages: [{ role: 'user', content: 'a question' }],
        result,
      });

      expect(result.text).toBe('debate synthesis');
      expect(result.response?.messages).toBeUndefined();
    });

    test('does nothing when mode is not debate', async () => {
      const result = { text: 'draft' };

      await maybeApplyDebateToResult({
        reasoningConfig: { mode: 'reflect' },
        agentId: 'agent_test',
        generationId: 'gen_test',
        messages: [],
        result,
      });

      expect(result.text).toBe('draft');
      expect(mockRunReasoningCompletion).not.toHaveBeenCalled();
    });

    test('keeps draft when debate falls back due to all perspectives failing', async () => {
      mockRunReasoningCompletion.mockRejectedValue(new Error('down'));

      const result = { text: 'original draft' };

      await maybeApplyDebateToResult({
        reasoningConfig: { mode: 'debate', perspectives: 2 },
        agentId: 'agent_test',
        generationId: 'gen_test',
        messages: [{ role: 'user', content: 'question' }],
        result,
      });

      expect(result.text).toBe('original draft');
    });
  });
});
