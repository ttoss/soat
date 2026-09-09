import {
  compileJsonSchema,
  describeSchemaErrors,
} from 'src/lib/jsonSchemaValidator';

/**
 * The shared compile cache behind every stored-schema check — an agent's
 * `output_schema`, a tool's `parameters`. Both of its unusual behaviours are
 * decisions rather than accidents, so both are pinned here: an uncompilable
 * schema yields `null` (the caller proceeds unchecked) and the result is
 * cached either way.
 */
describe('compileJsonSchema', () => {
  test('compiles a schema and validates against it', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { amount: { type: 'number', maximum: 10 } },
      required: ['amount'],
    });

    expect(validate).not.toBeNull();
    expect(validate?.({ amount: 5 })).toBe(true);
    expect(validate?.({ amount: 50 })).toBe(false);
  });

  test('returns the same compiled validator for an equal schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };

    expect(compileJsonSchema({ ...schema })).toBe(
      compileJsonSchema({ ...schema })
    );
  });

  // A schema ajv rejects is an authoring bug in a stored row. Refusing every
  // value on it would turn one malformed row into an outage on a path that had
  // no check at all before, so the caller is told "cannot check this".
  test('returns null for a schema ajv cannot compile', () => {
    expect(compileJsonSchema({ type: 'not-a-json-schema-type' })).toBeNull();
  });

  test('caches the uncompilable verdict too', () => {
    const bad = { type: 'also-not-a-type' };

    expect(compileJsonSchema({ ...bad })).toBeNull();
    expect(compileJsonSchema({ ...bad })).toBeNull();
  });

  // Author-written schemas carry keywords ajv does not know — vendor `x-*`
  // extensions, `$comment`, provider hints. In strict mode ajv throws on those
  // at compile time, which would make a harmless annotation a refusal.
  test('accepts a schema carrying unknown keywords', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      'x-soat-hint': 'ignored',
      $comment: 'also ignored',
    });

    expect(validate).not.toBeNull();
    expect(validate?.({ a: 'ok' })).toBe(true);
  });

  // `format` stays an annotation: asserting it would reject values whose
  // schema author never claimed were invalid.
  test('does not assert format', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { when: { type: 'string', format: 'date-time' } },
    });

    expect(validate?.({ when: 'not a date' })).toBe(true);
  });

  // The cap is a backstop against a pathological caller, not an expected path:
  // past it the cache clears rather than growing without bound.
  test('clears the cache rather than growing past its cap', () => {
    const schema = { type: 'object', properties: { keep: { type: 'string' } } };
    const before = compileJsonSchema({ ...schema });

    for (let index = 0; index < 501; index += 1) {
      compileJsonSchema({ type: 'object', title: `filler-${index}` });
    }

    expect(compileJsonSchema({ ...schema })).not.toBe(before);
  });
});

describe('describeSchemaErrors', () => {
  test('names each violated field', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { amount: { type: 'number', maximum: 10 } },
      required: ['amount', 'currency'],
    });
    validate?.({ amount: 50 });

    const described = describeSchemaErrors(validate?.errors);
    expect(described).toMatch(/amount/);
    expect(described).toMatch(/currency/);
  });

  // A root-level violation has an empty instancePath, which would otherwise
  // read as a message about nothing.
  test('names the root when the violation is the value itself', () => {
    const validate = compileJsonSchema({ type: 'object' });
    validate?.('not an object');

    expect(describeSchemaErrors(validate?.errors)).toMatch(/\(root\)/);
  });

  test.each([[undefined], [null], [[]]])(
    'says something for %p rather than an empty string',
    (errors) => {
      expect(describeSchemaErrors(errors as never)).toBe('unknown violation');
    }
  );
});
