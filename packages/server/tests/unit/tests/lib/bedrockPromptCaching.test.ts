import { generateText } from 'ai';
import { buildModel } from 'src/lib/agentModel';
import {
  buildStepCacheBreakpoint,
  withPromptCacheBreakpoint,
} from 'src/lib/promptCaching';

/**
 * What a caching agent's turn puts on the wire to Bedrock. Asserted on the
 * request body because Bedrock is the party that refuses a cache point, and
 * only the outbound request shows whether one was sent.
 */
let fetchMock: jest.SpiedFunction<typeof fetch>;

const CONVERSE_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const ENABLED = { enabled: true };

/**
 * The Converse request body a caching agent's turn sends for `model`, with
 * both of its marks: the system block's and the step's last message's.
 */
const sentBody = async (model: string): Promise<string> => {
  // Outbound HTTP to AWS is the one boundary faked here; the egress guard,
  // the provider and the SDK all run for real.
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(CONVERSE_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );

  const marked = withPromptCacheBreakpoint({
    promptCaching: ENABLED,
    messages: [
      { role: 'system' as const, content: 'Be terse.' },
      { role: 'user' as const, content: 'hi' },
    ],
  });

  await generateText({
    model: buildModel({
      provider: 'bedrock',
      secretValue: 'ABSKexample',
      model,
      config: { region: 'us-east-1' },
    }),
    instructions: marked.filter((message) => {
      return message.role === 'system';
    }),
    messages: marked.filter((message) => {
      return message.role !== 'system';
    }),
    prepareStep: ({ messages }) => {
      return { messages: buildStepCacheBreakpoint(ENABLED)?.(messages) };
    },
  });

  const init = fetchMock.mock.calls.at(-1)?.[1];
  return String(init?.body);
};

beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a Bedrock model that does not cache', () => {
  // Bedrock refuses a cache point on such a model with a 403 rather than
  // ignoring it, so the mark has to be withheld from the request.
  test.each([
    'zai.glm-4.7-flash',
    'meta.llama3-70b-instruct-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
  ])('%s is sent no cache point', async (model) => {
    const body = await sentBody(model);
    expect(body).toContain('Be terse.');
    expect(body).not.toContain('cachePoint');
  });
});

describe('a Bedrock model that caches', () => {
  test.each([
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'us.anthropic.claude-opus-4-1-20250805-v1:0',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-3-7-sonnet-20250219-v1:0',
    'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    'amazon.nova-lite-v1:0',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0',
  ])('%s keeps both cache points', async (model) => {
    const body = await sentBody(model);
    expect(body.match(/cachePoint/g)).toHaveLength(2);
  });
});
