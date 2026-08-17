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
    expect(pickMergedContent({ consolidated: 'Merged fact' })).toBe(
      'Merged fact'
    );
  });

  test('trims the consolidated text', () => {
    expect(pickMergedContent({ consolidated: '  Merged fact  ' })).toBe(
      'Merged fact'
    );
  });

  // There is no concatenation fallback any more (#1062): a blank completion
  // means "do not merge", and the caller creates a new entry instead. Merging
  // an existing entry into a blank string would lose the fact it already held.
  test('returns null when consolidation produced nothing usable', () => {
    expect(pickMergedContent({ consolidated: '' })).toBeNull();
    expect(pickMergedContent({ consolidated: '   \n ' })).toBeNull();
  });
});
