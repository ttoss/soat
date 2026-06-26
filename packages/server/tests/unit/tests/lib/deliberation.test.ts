import { maybeApplyDebateToResult, runDebate } from 'src/lib/deliberation';
import * as eventBusModule from 'src/lib/eventBus';
import * as generationsModule from 'src/lib/generations';
import * as reasoningModule from 'src/lib/reasoning';
import * as reasoningCompletionModule from 'src/lib/reasoningCompletion';

const mockRunReasoningCompletion = jest.spyOn(
  reasoningCompletionModule,
  'runReasoningCompletion'
);

const mockCreateGenerationRecord = jest.spyOn(
  generationsModule,
  'createGenerationRecord'
);

const mockUpdateGenerationRecord = jest.spyOn(
  generationsModule,
  'updateGenerationRecord'
);

const mockRecordReasoningSummary = jest.spyOn(
  reasoningModule,
  'recordReasoningSummary'
);

const mockEmitEvent = jest.spyOn(eventBusModule, 'emitEvent');

// Default no-op implementations so unrelated tests don't hit the DB / bus.
// clearAllMocks() (below) resets call counts but keeps these implementations.
mockRecordReasoningSummary.mockResolvedValue(undefined);
mockEmitEvent.mockImplementation(() => {
  return undefined;
});

describe('deliberation lib', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('child generation records (observability context)', () => {
    const fakeGeneration = {
      id: 'gen_child01',
      projectId: 'prj_01',
      agentId: 'agent_debate01',
      traceId: 'trc_01',
      initiatorGenerationId: 'gen_parent01',
      startedByPrincipalType: null,
      startedByPrincipalId: null,
      status: 'in_progress',
      startedAt: new Date(),
      completedAt: null,
      lastActivityAt: null,
      stopReason: null,
      error: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      mockCreateGenerationRecord.mockResolvedValue(fakeGeneration);
      mockUpdateGenerationRecord.mockResolvedValue({
        ...fakeGeneration,
        status: 'completed',
      });
    });

    test('creates a child generation record for each perspective and synthesis when observability context is provided', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis result');

      await runDebate({
        agentId: 'agent_debate01',
        projectIds: [1],
        messages: [{ role: 'user', content: 'question' }],
        temperature: null,
        reasoning: { mode: 'debate', perspectives: 2 },
        traceId: 'trc_01',
        projectId: 1,
        initiatorGenerationId: 'gen_parent01',
      });

      // 2 perspectives + 1 synthesis = 3 child records created
      expect(mockCreateGenerationRecord).toHaveBeenCalledTimes(3);
      // All share the same traceId and initiatorGenerationId
      expect(mockCreateGenerationRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trc_01',
          agentId: 'agent_debate01',
          projectId: 1,
          initiatorGenerationId: 'gen_parent01',
        })
      );
    });

    test('marks perspective child generation completed with perspective name in metadata', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis result');

      await runDebate({
        agentId: 'agent_debate01',
        projectIds: [1],
        messages: [{ role: 'user', content: 'question' }],
        temperature: null,
        reasoning: { mode: 'debate', perspectives: 2 },
        traceId: 'trc_01',
        projectId: 1,
        initiatorGenerationId: 'gen_parent01',
      });

      // First two updates are perspective completions
      const perspectiveUpdate = mockUpdateGenerationRecord.mock.calls.find(
        ([args]) => {
          return (
            (args.metadata?.reasoning as Record<string, unknown> | undefined)
              ?.perspective === 'Advocate'
          );
        }
      );
      expect(perspectiveUpdate).toBeDefined();
      expect(perspectiveUpdate![0]).toMatchObject({
        status: 'completed',
        stopReason: 'stop',
        metadata: {
          reasoning: { perspective: 'Advocate', output: 'advocate text' },
        },
      });
    });

    test('marks synthesis child generation completed with "synthesis" perspective in metadata', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis result');

      await runDebate({
        agentId: 'agent_debate01',
        projectIds: [1],
        messages: [{ role: 'user', content: 'question' }],
        temperature: null,
        reasoning: { mode: 'debate', perspectives: 2 },
        traceId: 'trc_01',
        projectId: 1,
        initiatorGenerationId: 'gen_parent01',
      });

      const synthesisUpdate = mockUpdateGenerationRecord.mock.calls.find(
        ([args]) => {
          return (
            (args.metadata?.reasoning as Record<string, unknown> | undefined)
              ?.perspective === 'synthesis'
          );
        }
      );
      expect(synthesisUpdate).toBeDefined();
      expect(synthesisUpdate![0]).toMatchObject({
        status: 'completed',
        stopReason: 'stop',
        metadata: {
          reasoning: { perspective: 'synthesis', output: 'synthesis result' },
        },
      });
    });

    test('perspective metadata includes round number', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate r1')
        .mockResolvedValueOnce('skeptic r1')
        .mockResolvedValueOnce('advocate r2')
        .mockResolvedValueOnce('skeptic r2')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        agentId: 'agent_debate01',
        projectIds: [1],
        messages: [{ role: 'user', content: 'question' }],
        temperature: null,
        reasoning: { mode: 'debate', perspectives: 2, maxRounds: 2 },
        traceId: 'trc_01',
        projectId: 1,
        initiatorGenerationId: 'gen_parent01',
      });

      const r0AdvocateUpdate = mockUpdateGenerationRecord.mock.calls.find(
        ([args]) => {
          return (
            (args.metadata?.reasoning as Record<string, unknown> | undefined)
              ?.perspective === 'Advocate' &&
            (args.metadata?.reasoning as Record<string, unknown> | undefined)
              ?.round === 0
          );
        }
      );
      expect(r0AdvocateUpdate).toBeDefined();

      const r1AdvocateUpdate = mockUpdateGenerationRecord.mock.calls.find(
        ([args]) => {
          return (
            (args.metadata?.reasoning as Record<string, unknown> | undefined)
              ?.perspective === 'Advocate' &&
            (args.metadata?.reasoning as Record<string, unknown> | undefined)
              ?.round === 1
          );
        }
      );
      expect(r1AdvocateUpdate).toBeDefined();
    });

    test('marks perspective child generation failed when perspective call throws', async () => {
      mockRunReasoningCompletion
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis');

      await runDebate({
        agentId: 'agent_debate01',
        projectIds: [1],
        messages: [{ role: 'user', content: 'question' }],
        temperature: null,
        reasoning: { mode: 'debate', perspectives: 2 },
        traceId: 'trc_01',
        projectId: 1,
        initiatorGenerationId: 'gen_parent01',
      });

      const failedUpdate = mockUpdateGenerationRecord.mock.calls.find(
        ([args]) => {
          return args.status === 'failed';
        }
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate![0]).toMatchObject({
        status: 'failed',
        completedAt: expect.any(Date),
      });
    });

    test('does not create child generation records when no observability context is provided', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate text')
        .mockResolvedValueOnce('skeptic text')
        .mockResolvedValueOnce('synthesis result');

      await runDebate({
        agentId: 'agent_debate01',
        projectIds: [1],
        messages: [{ role: 'user', content: 'question' }],
        temperature: null,
        reasoning: { mode: 'debate', perspectives: 2 },
      });

      expect(mockCreateGenerationRecord).not.toHaveBeenCalled();
    });
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
      expect(firstCall.prompt).toContain('Should we invest in this project?');
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

      const synthCall = mockRunReasoningCompletion.mock.calls[2][0];
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

      const synthCall = mockRunReasoningCompletion.mock.calls[2][0];
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

  describe('runDebate telemetry', () => {
    const baseArgs = {
      agentId: 'agent_debate01',
      projectIds: [1],
      messages: [{ role: 'user', content: 'question' }],
      temperature: null,
    };

    test('reports perspectives, rounds and dropped=0 on a clean run', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('advocate')
        .mockResolvedValueOnce('skeptic')
        .mockResolvedValueOnce('synthesis');

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2 },
      });

      expect(result.perspectives).toBe(2);
      expect(result.rounds).toBe(1);
      expect(result.dropped).toBe(0);
    });

    test('counts dropped perspective turns', async () => {
      mockRunReasoningCompletion
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce('skeptic')
        .mockResolvedValueOnce('pragmatist')
        .mockResolvedValueOnce('synthesis');

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 3 },
      });

      expect(result.applied).toBe(true);
      expect(result.perspectives).toBe(3);
      expect(result.rounds).toBe(1);
      expect(result.dropped).toBe(1);
    });

    test('reports full drop count on a fallback', async () => {
      mockRunReasoningCompletion.mockRejectedValue(new Error('down'));

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 3 },
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('fallback');
      expect(result.perspectives).toBe(3);
      expect(result.dropped).toBe(3);
    });

    test('rounds reflects the capped maxRounds', async () => {
      for (let i = 0; i < 7; i++) {
        mockRunReasoningCompletion.mockResolvedValueOnce(`text ${i}`);
      }

      const result = await runDebate({
        ...baseArgs,
        reasoning: { mode: 'debate', perspectives: 2, maxRounds: 10 },
      });

      expect(result.rounds).toBe(3);
    });
  });

  describe('maybeApplyDebateToResult observability', () => {
    test('records a rich reasoning summary with telemetry', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('p1')
        .mockResolvedValueOnce('p2')
        .mockResolvedValueOnce('synthesis');

      await maybeApplyDebateToResult({
        reasoningConfig: { mode: 'debate', perspectives: 2 },
        agentId: 'agent_test',
        generationId: 'gen_test',
        projectId: 1,
        projectPublicId: 'prj_01',
        messages: [{ role: 'user', content: 'question' }],
        result: { text: 'draft' },
      });

      expect(mockRecordReasoningSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          generationId: 'gen_test',
          summary: expect.objectContaining({
            mode: 'debate',
            applied: true,
            reason: 'synthesized',
            perspectives: 2,
            rounds: 1,
            dropped: 0,
            fallback: false,
          }),
        })
      );
    });

    test('emits a fallback event when debate degrades to the draft', async () => {
      mockRunReasoningCompletion.mockRejectedValue(new Error('down'));

      await maybeApplyDebateToResult({
        reasoningConfig: { mode: 'debate', perspectives: 2 },
        agentId: 'agent_test',
        generationId: 'gen_test',
        projectId: 1,
        projectPublicId: 'prj_01',
        messages: [{ role: 'user', content: 'question' }],
        result: { text: 'draft' },
      });

      expect(mockEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agents.reasoning.fallback',
          projectId: 1,
          projectPublicId: 'prj_01',
          resourceType: 'generation',
          resourceId: 'gen_test',
          data: expect.objectContaining({
            mode: 'debate',
            reason: 'fallback',
          }),
        })
      );
    });

    test('does not emit a fallback event when debate succeeds', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('p1')
        .mockResolvedValueOnce('p2')
        .mockResolvedValueOnce('synthesis');

      await maybeApplyDebateToResult({
        reasoningConfig: { mode: 'debate', perspectives: 2 },
        agentId: 'agent_test',
        generationId: 'gen_test',
        projectId: 1,
        projectPublicId: 'prj_01',
        messages: [{ role: 'user', content: 'question' }],
        result: { text: 'draft' },
      });

      const fallbackEmits = mockEmitEvent.mock.calls.filter(([event]) => {
        return event.type === 'agents.reasoning.fallback';
      });
      expect(fallbackEmits).toHaveLength(0);
    });
  });
});
