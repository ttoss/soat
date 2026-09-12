import { DomainError } from 'src/errors';
import {
  assertValidPromptCaching,
  readPromptCachingConfig,
  withPromptCacheBreakpoint,
} from 'src/lib/promptCaching';

const BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
  bedrock: { cachePoint: { type: 'default' } },
};

const enabled = { enabled: true };

describe('readPromptCachingConfig', () => {
  test('reads an enabled config', () => {
    expect(readPromptCachingConfig(enabled)).toEqual({ enabled: true });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'true'],
    ['an array', [{ enabled: true }]],
    ['an empty object', {}],
    ['a truthy non-boolean', { enabled: 'yes' }],
  ])('%s reads as off', (_label, value) => {
    expect(readPromptCachingConfig(value)).toEqual({ enabled: false });
  });
});

describe('assertValidPromptCaching', () => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['enabled true', { enabled: true }],
    ['enabled false', { enabled: false }],
  ])('%s is accepted', (_label, value) => {
    expect(() => {
      return assertValidPromptCaching(value);
    }).not.toThrow();
  });

  test('a non-object is refused', () => {
    expect(() => {
      return assertValidPromptCaching('yes');
    }).toThrow(DomainError);
  });

  // The failure this refusal exists for: a misspelled key left an agent its
  // author believed was caching, silently never caching.
  test('an unknown key is refused, and named', () => {
    expect(() => {
      return assertValidPromptCaching({ enable: true });
    }).toThrow(/enable/);
  });

  test('a non-boolean `enabled` is refused', () => {
    expect(() => {
      return assertValidPromptCaching({ enabled: 'true' });
    }).toThrow(DomainError);
  });
});

describe('withPromptCacheBreakpoint', () => {
  const messages = [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'hi' },
  ];

  test('marks the system message when caching is enabled', () => {
    expect(
      withPromptCacheBreakpoint({ promptCaching: enabled, messages })
    ).toEqual([
      { role: 'system', content: 'Be terse.', providerOptions: BREAKPOINT },
      { role: 'user', content: 'hi' },
    ]);
  });

  test.each([
    ['no config', null],
    ['an explicitly disabled config', { enabled: false }],
  ])('%s leaves the history untouched', (_label, promptCaching) => {
    expect(withPromptCacheBreakpoint({ promptCaching, messages })).toBe(
      messages
    );
  });

  test('never mutates the history it was handed', () => {
    withPromptCacheBreakpoint({ promptCaching: enabled, messages });

    expect(messages[0]).toEqual({ role: 'system', content: 'Be terse.' });
  });

  // The prefix is tools → system → messages, so the mark has to sit on the LAST
  // system block for the tool definitions before it to fall inside the cached
  // prefix. On an earlier one it would cache the tools and nothing else.
  test('marks the last system message, not the first', () => {
    expect(
      withPromptCacheBreakpoint({
        promptCaching: enabled,
        messages: [
          { role: 'system', content: 'first' },
          { role: 'system', content: 'second' },
          { role: 'user', content: 'hi' },
        ],
      })
    ).toEqual([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second', providerOptions: BREAKPOINT },
      { role: 'user', content: 'hi' },
    ]);
  });

  test('an agent with no instructions has no block to mark', () => {
    const noSystem = [{ role: 'user', content: 'hi' }];

    expect(
      withPromptCacheBreakpoint({ promptCaching: enabled, messages: noSystem })
    ).toBe(noSystem);
  });

  // A paused turn replays its persisted messages through the same assembly, so
  // re-marking must not compound into a second breakpoint.
  test('re-marking an already marked history is a no-op', () => {
    const once = withPromptCacheBreakpoint({
      promptCaching: enabled,
      messages,
    });

    expect(
      withPromptCacheBreakpoint({ promptCaching: enabled, messages: once })
    ).toEqual(once);
  });
});
