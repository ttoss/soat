import { replayStoredTurn, splitVendorOptions } from 'src/lib/vendorOptions';

const cache = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const itemId = { openai: { itemId: 'msg_1' } };

describe('replayStoredTurn', () => {
  test('rejoins split vendor options on the message and its parts', () => {
    const original = [
      { role: 'user', content: 'hi', providerOptions: cache },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b', providerOptions: itemId },
        ],
        providerOptions: cache,
      },
    ];
    const { messages, vendorOptions } = splitVendorOptions({
      messages: original,
    });

    expect(JSON.stringify(messages)).not.toContain('providerOptions');
    expect(replayStoredTurn({ messages, vendorOptions })).toEqual(original);
  });

  test('a message with no vendor options replays unchanged', () => {
    const messages = [{ role: 'user', content: 'hi' }, 'not a message'];

    expect(
      replayStoredTurn({
        messages,
        vendorOptions: [{ message: 1, options: cache }],
      })
    ).toEqual(messages);
  });

  test('a message that carried only reasoning is not replayed', () => {
    const answer = {
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }],
    };

    expect(
      replayStoredTurn({
        messages: [
          { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }] },
          answer,
        ],
        vendorOptions: [{ message: 0, part: 0, options: itemId }],
      })
    ).toEqual([answer]);
  });
});
