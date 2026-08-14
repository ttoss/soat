import {
  collectSystemInstructions,
  hasSystemMessage,
  withoutSystemMessages,
} from 'src/lib/modelMessages';

/**
 * The system/non-system split every provider call performs. Pure, and with a
 * combinatorial input space (zero / one / many system messages, at any position,
 * with string or structured content), so it is tested directly rather than
 * through an entry point.
 *
 * The contract mirrors the AI SDK's, which is the reason this shape exists:
 *
 *   type Instructions = string | SystemModelMessage | Array<SystemModelMessage>
 *   allowSystemInMessages?: boolean   // @default false
 *
 * `standardizePrompt` throws `InvalidPromptError` for a system message left in
 * `messages`, so everything system-shaped must be lifted into `instructions` —
 * and because `Instructions` accepts an *ordered array*, nothing has to be
 * dropped or concatenated to fit. The previous helper took `.find` (the first
 * message) while the filter removed all of them, so every system message after
 * the first was silently destroyed.
 */
describe('collectSystemInstructions', () => {
  test('no system message yields undefined', () => {
    expect(
      collectSystemInstructions([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ])
    ).toBeUndefined();
  });

  test('a single system message yields its content as a string', () => {
    expect(
      collectSystemInstructions([
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
      ])
    ).toBe('Be terse.');
  });

  test('several system messages are all kept, in order, as SystemModelMessages', () => {
    expect(
      collectSystemInstructions([
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Answer in French.' },
      ])
    ).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'system', content: 'Answer in French.' },
    ]);
  });

  test('a later system message is never discarded in favour of the first', () => {
    const instructions = collectSystemInstructions([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
    ]);

    expect(JSON.stringify(instructions)).toContain('second');
  });

  /* Providers accept only string content for a system message, and
   * `SystemModelMessage` types it that way, so a structured payload cannot be
   * represented as an instruction. It is reported rather than dropped — see
   * `hasSystemMessage`, which the agent path uses to reject the whole request. */
  test('a system message whose content is not a string is not turned into instructions', () => {
    expect(
      collectSystemInstructions([
        { role: 'system', content: [{ type: 'text', text: 'nope' }] },
        { role: 'user', content: 'hi' },
      ])
    ).toBeUndefined();
  });

  test('reads role and content only, leaving other keys untouched', () => {
    const message = {
      role: 'system',
      content: 'Be terse.',
      providerOptions: { anthropic: { cache_control: { type: 'ephemeral' } } },
    };

    expect(collectSystemInstructions([message])).toBe('Be terse.');
    expect(message.providerOptions).toEqual({
      anthropic: { cache_control: { type: 'ephemeral' } },
    });
  });
});

describe('withoutSystemMessages', () => {
  test('removes every system message, whatever its position', () => {
    expect(
      withoutSystemMessages([
        { role: 'system', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'system', content: 'c' },
      ])
    ).toEqual([{ role: 'user', content: 'b' }]);
  });

  test('leaves a history with no system message alone', () => {
    const messages = [{ role: 'user', content: 'b' }];
    expect(withoutSystemMessages(messages)).toEqual(messages);
  });
});

describe('hasSystemMessage', () => {
  test('true when any message carries the system role', () => {
    expect(
      hasSystemMessage([
        { role: 'user', content: 'a' },
        { role: 'system', content: 'b' },
      ])
    ).toBe(true);
  });

  test('true even when the content is structured rather than a string', () => {
    expect(
      hasSystemMessage([{ role: 'system', content: [{ type: 'text' }] }])
    ).toBe(true);
  });

  test('false for a history of user and assistant turns', () => {
    expect(
      hasSystemMessage([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ])
    ).toBe(false);
  });
});
