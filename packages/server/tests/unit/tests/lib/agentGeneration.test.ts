import { createGeneration, submitToolOutputs } from 'src/lib/agentGeneration';

describe('createGeneration', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns not_found when agent does not exist', async () => {
    const result = await createGeneration({
      agentId: 'nonexistent_agent_id',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result).toBe('not_found');
  });

  test('returns depth guard result when remainingDepth is 0', async () => {
    const result = await createGeneration({
      agentId: 'any_agent_id',
      messages: [{ role: 'user', content: 'hello' }],
      remainingDepth: 0,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: expect.objectContaining({
        content: 'Maximum call depth reached',
        finishReason: 'stop',
      }),
    });
  });
});

describe('submitToolOutputs', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns generation_not_found when generation does not exist', async () => {
    const result = await submitToolOutputs({
      agentId: 'agent_id',
      generationId: 'gen_nonexistent_0000',
      toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
    });

    expect(result).toBe('generation_not_found');
  });
});
