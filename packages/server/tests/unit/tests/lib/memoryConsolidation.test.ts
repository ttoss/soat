import {
  buildConsolidationPrompt,
  pickMergedContent,
} from 'src/lib/memoryConsolidation';

describe('buildConsolidationPrompt', () => {
  test('includes both facts and instructs a single consolidated fact', () => {
    const prompt = buildConsolidationPrompt({
      existing: 'Customer prefers email over phone calls',
      incoming: 'Customer prefers email, especially for billing',
    });

    expect(prompt).toContain('Customer prefers email over phone calls');
    expect(prompt).toContain('Customer prefers email, especially for billing');
    // Must steer the model to one atomic fact, not a concatenation.
    expect(prompt).toMatch(/single|one\b/i);
  });

  test('instructs preferring the new fact on contradiction', () => {
    const prompt = buildConsolidationPrompt({
      existing: 'Customer prefers phone',
      incoming: 'Customer prefers email',
    });

    expect(prompt).toMatch(/contradict/i);
    expect(prompt).toMatch(/new/i);
  });
});

describe('pickMergedContent', () => {
  test('uses the consolidated text when it is non-empty', () => {
    expect(
      pickMergedContent({ consolidated: 'Merged fact', fallback: 'a\nb' })
    ).toBe('Merged fact');
  });

  test('trims the consolidated text', () => {
    expect(
      pickMergedContent({ consolidated: '  Merged fact  ', fallback: 'a\nb' })
    ).toBe('Merged fact');
  });

  test('falls back to the concatenation when consolidation is empty', () => {
    expect(pickMergedContent({ consolidated: '', fallback: 'a\nb' })).toBe(
      'a\nb'
    );
    expect(
      pickMergedContent({ consolidated: '   \n ', fallback: 'a\nb' })
    ).toBe('a\nb');
  });
});
