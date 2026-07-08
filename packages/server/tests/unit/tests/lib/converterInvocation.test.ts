import { DomainError } from 'src/errors';
import { parseConverterOutput } from 'src/lib/converterInvocation';

describe('parseConverterOutput', () => {
  test('a whitespace-only string yields zero ready pages', () => {
    expect(parseConverterOutput('   \n\t  ')).toEqual({
      status: 'ready',
      pages: [],
    });
  });

  test('a top-level shape that is neither a string nor a record throws CONVERTER_OUTPUT_INVALID', () => {
    const inputs = [42, null, ['pages'], true];
    expect.assertions(inputs.length * 2);
    for (const raw of inputs) {
      try {
        parseConverterOutput(raw);
        throw new Error('expected parseConverterOutput to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe('CONVERTER_OUTPUT_INVALID');
      }
    }
  });

  test('a non-record page entry falls back to an empty text and is dropped', () => {
    // `'not a record'` and `123` are neither objects (so `isRecord` is false),
    // so the entry is treated as `{}` — no `text` key, which trims to '' and
    // is filtered out.
    expect(parseConverterOutput({ pages: ['not a record', 123] })).toEqual({
      status: 'ready',
      pages: [],
    });
  });
});
