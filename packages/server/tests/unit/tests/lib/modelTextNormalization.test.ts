import { generateText, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  normalizationCounterSnapshot,
  resetNormalizationCounters,
  withModelTextNormalization,
} from 'src/lib/modelTextNormalization';

/**
 * The normaliser is a pure algorithm over a large input space — every vendor's
 * markup, split at every delta boundary — which no HTTP-level assertion can
 * resolve: through a route, all of it collapses into one `content` string.
 * The keep-list case 1 in `.claude/rules/tests.md`.
 *
 * Every case is named after the rule it pins, never after the model that
 * happened to report it: the contract is the rule.
 */

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;

const USAGE: GenerateResult['usage'] = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const FINISH = { unified: 'stop' as const, raw: 'stop' };

/** Runs one generated text part through the normaliser. */
const generated = async (text: string) => {
  return generateText({
    model: withModelTextNormalization({
      model: new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: 'text', text }],
          finishReason: FINISH,
          usage: USAGE,
          warnings: [],
        },
      }),
      provider: 'bedrock',
      modelId: 'test-model',
    }),
    prompt: 'ping',
  });
};

const streamOf = (deltas: string[]): StreamResult => {
  return {
    stream: new ReadableStream({
      start: (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: '0' });
        for (const delta of deltas) {
          controller.enqueue({ type: 'text-delta', id: '0', delta });
        }
        controller.enqueue({ type: 'text-end', id: '0' });
        controller.enqueue({
          type: 'finish',
          finishReason: FINISH,
          usage: USAGE,
        });
        controller.close();
      },
    }),
  };
};

/** Runs one streamed text run, delta by delta, through the normaliser. */
const streamed = async (deltas: string[]) => {
  const result = streamText({
    model: withModelTextNormalization({
      model: new MockLanguageModelV4({ doStream: streamOf(deltas) }),
      provider: 'bedrock',
      modelId: 'test-model',
    }),
    prompt: 'ping',
  });
  const chunks: string[] = [];
  for await (const chunk of result.textStream) {
    chunks.push(chunk);
  }
  return { chunks, text: await result.text, content: await result.content };
};

beforeEach(() => {
  resetNormalizationCounters();
});

describe('special-token rule', () => {
  test('strips an ASCII pipe-delimited token from the text channel', async () => {
    const result = await generated('answer <|im_start|> tail');
    expect(result.text).toBe('answer  tail');
  });

  test('strips a fullwidth pipe-delimited token that runs to the end', async () => {
    const result = await generated('answer\n\n<｜DSML｜function_calls');
    expect(result.text).toBe('answer\n\n');
  });

  test('strips a token carrying a SentencePiece word marker', async () => {
    const result = await generated('a <｜tool▁calls▁begin｜> b');
    expect(result.text).toBe('a  b');
  });

  test('leaves in-band ASCII instruction markers alone', async () => {
    const result = await generated('[INST] <<SYS>> <s>keep</s>');
    expect(result.text).toBe('[INST] <<SYS>> <s>keep</s>');
  });

  test('leaves ordinary prose containing an angle bracket alone', async () => {
    const result = await generated('if a < b then <div>x</div>');
    expect(result.text).toBe('if a < b then <div>x</div>');
  });

  test('passes a paired channel marker through unchanged', async () => {
    const harmony =
      '<|start|>assistant<|channel|>analysis<|message|>weighing<|end|>';
    const result = await generated(harmony);
    expect(result.text).toBe(harmony);
  });

  test('strips a dangling pipe-delimited token split across two deltas', async () => {
    const result = await streamed(['pong\n\n<｜DSML', '｜function_calls']);
    expect(result.text).toBe('pong\n\n');
  });

  test('strips a token whose opener alone ends a delta', async () => {
    const result = await streamed(['pong <', '|im_end|>', ' tail']);
    expect(result.text).toBe('pong  tail');
  });

  test('emits a streamed text run unchanged when no rule fires', async () => {
    const result = await streamed(['po', 'ng']);
    expect(result.chunks).toEqual(['po', 'ng']);
  });
});

describe('reasoning-tag rule', () => {
  test.each(['thinking', 'think', 'reasoning', 'scratchpad'])(
    'moves a <%s> section out of the text channel',
    async (tag) => {
      const result = await generated(`<${tag}>weighing</${tag}>  pong`);
      expect(result.text).toBe('  pong');
      expect(result.reasoningText).toBe('weighing');
    }
  );

  test('moves a reasoning section split across deltas out of the text channel', async () => {
    const result = await streamed(['<think', 'ing>weighing</thinking>pong']);
    expect(result.text).toBe('pong');
  });
});

describe('empty-part rule', () => {
  test('drops a generated text part left whitespace-only by a rule', async () => {
    const result = await generated('<thinking>weighing</thinking>');
    expect(result.content).not.toContainEqual(
      expect.objectContaining({ type: 'text' })
    );
  });

  test('drops a streamed text run left whitespace-only by a rule', async () => {
    const result = await streamed(['\n\n<｜DSML｜function_calls']);
    expect(result.chunks).toEqual([]);
    expect(result.content).not.toContainEqual(
      expect.objectContaining({ type: 'text' })
    );
  });

  test('keeps an empty text part no rule touched', async () => {
    const result = await generated('');
    expect(result.content).toContainEqual({ type: 'text', text: '' });
  });
});

describe('normalization counters', () => {
  test('counts the rule, model and provider when a rule fires', async () => {
    await generated('pong <|im_end|>');
    expect(normalizationCounterSnapshot()).toEqual([
      {
        rule: 'special_token_stripped',
        provider: 'bedrock',
        model: 'test-model',
        count: 1,
      },
    ]);
  });

  test('counts a recognised channel marker separately from a strip', async () => {
    await generated('<|channel|>analysis<|message|>weighing<|end|>');
    expect(normalizationCounterSnapshot()).toEqual([
      {
        rule: 'channel_marker_recognized',
        provider: 'bedrock',
        model: 'test-model',
        count: 1,
      },
    ]);
  });

  test('counts nothing when no rule fires', async () => {
    await generated('pong');
    expect(normalizationCounterSnapshot()).toEqual([]);
  });
});
