import { parseHandlerFacts } from 'src/lib/memoryRuleHandlers';

/**
 * The contract every handler's reply is read through, and the one place a
 * memory rule touches text it did not write. A `lib/` test rather than a REST
 * one: it is a pure parser over a large input space, and driving each shape
 * through a live handler would cost a generation apiece to assert the same
 * thing at lower resolution.
 *
 * It never throws by design — a handler that answers with nonsense contributes
 * nothing, which is the same outcome as answering with no facts.
 */
describe('parseHandlerFacts', () => {
  test('reads the documented { facts: [...] } shape', () => {
    expect(
      parseHandlerFacts({
        facts: [{ content: 'Customer prefers email', tags: { kind: 'pref' } }],
      })
    ).toEqual([{ content: 'Customer prefers email', tags: { kind: 'pref' } }]);
  });

  test('accepts a bare array, which a model reaches for', () => {
    expect(parseHandlerFacts([{ content: 'The invoice is paid' }])).toEqual([
      { content: 'The invoice is paid', tags: null },
    ]);
  });

  test('accepts bare strings as facts', () => {
    expect(parseHandlerFacts(['  A fact  ', ''])).toEqual([
      { content: 'A fact', tags: null },
    ]);
  });

  test('finds the JSON inside a string reply wrapped in prose', () => {
    expect(
      parseHandlerFacts('Here you go:\n{"facts":[{"content":"A fact"}]}\nDone.')
    ).toEqual([{ content: 'A fact', tags: null }]);
  });

  test('falls back to an array span when the reply has no object', () => {
    expect(parseHandlerFacts('```json\n["A fact"]\n```')).toEqual([
      { content: 'A fact', tags: null },
    ]);
  });

  test('drops non-string tag values, and keeps no bag when none survive', () => {
    expect(
      parseHandlerFacts({
        facts: [{ content: 'A fact', tags: { kind: 'pref', weight: 3 } }],
      })
    ).toEqual([{ content: 'A fact', tags: { kind: 'pref' } }]);
    expect(
      parseHandlerFacts({ facts: [{ content: 'A fact', tags: { weight: 3 } }] })
    ).toEqual([{ content: 'A fact', tags: null }]);
    expect(
      parseHandlerFacts({ facts: [{ content: 'A fact', tags: 'not a bag' }] })
    ).toEqual([{ content: 'A fact', tags: null }]);
  });

  test('drops items that carry no content', () => {
    expect(
      parseHandlerFacts({
        facts: [{ content: 'A fact' }, { nope: true }, 42, null],
      })
    ).toEqual([{ content: 'A fact', tags: null }]);
  });

  test('proposes nothing for a reply it cannot read', () => {
    expect(parseHandlerFacts('no json here at all')).toEqual([]);
    expect(parseHandlerFacts('{"facts": not json}')).toEqual([]);
    expect(parseHandlerFacts({ facts: 'not an array' })).toEqual([]);
    expect(parseHandlerFacts(null)).toEqual([]);
  });

  test('caps a flood of candidates at 20', () => {
    const facts = Array.from({ length: 25 }, (_, i) => {
      return { content: `fact ${i}` };
    });
    expect(parseHandlerFacts({ facts })).toHaveLength(20);
  });
});
