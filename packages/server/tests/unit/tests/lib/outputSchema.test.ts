import {
  buildStructuredOutput,
  validateStructuredOutput,
} from 'src/lib/outputSchema';

// A pure algorithm over every JSON Schema keyword an author may write. Reaching
// one keyword through a generation would need a full fixture chain per case, and
// the bare 502 would hide which keyword fired. That a generation reaches the
// validator is pinned in `rest/agentOutputSchema.test.ts`.
describe('validateStructuredOutput', () => {
  const themeSchema = {
    type: 'object',
    required: ['approved', 'reason', 'title', 'text'],
    properties: {
      text: { type: 'string', minLength: 200 },
      title: { type: 'string', minLength: 3 },
      reason: { type: 'string', minLength: 10 },
      approved: { type: 'boolean' },
    },
  };

  test('accepts an object that satisfies the schema', () => {
    const value = {
      text: 'a'.repeat(200),
      title: 'A casa arrumada para a visita',
      approved: true,
      reason: 'Apenas expõe o mecanismo, sem instalar outra ilusão.',
    };
    const result = validateStructuredOutput(themeSchema)(value);
    expect(result.success).toBe(true);
    expect(result.success && result.value).toEqual(value);
  });

  // The regression this module exists for: a model returned every required key
  // with every type correct, filled with the name of the agent's own tool. A
  // required+type-only check passes that; `minLength` is what rejects it.
  test('rejects a degenerate object whose keys and types are all correct', () => {
    const result = validateStructuredOutput(themeSchema)({
      text: 'get-fundamental-truth',
      title: 'get-fundamental-truth',
      reason: 'get-fundamental-truth',
      approved: true,
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toMatch(/text/);
  });

  test('rejects a missing required field', () => {
    const result = validateStructuredOutput(themeSchema)({
      text: 'a'.repeat(200),
      title: 'Título',
      approved: true,
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toMatch(/reason/);
  });

  test('rejects a wrong primitive type', () => {
    const result = validateStructuredOutput(themeSchema)({
      text: 'a'.repeat(200),
      title: 'Título',
      reason: 'porque sim, e mais um pouco',
      approved: 'true',
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toMatch(
      /approved/
    );
  });

  test('honors nested object and array constraints', () => {
    const nested = {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'integer', minimum: 1 } },
          },
        },
      },
    };
    expect(
      validateStructuredOutput(nested)({ items: [{ id: 1 }] }).success
    ).toBe(false);
    expect(
      validateStructuredOutput(nested)({ items: [{ id: 1 }, { id: 0 }] })
        .success
    ).toBe(false);
    expect(
      validateStructuredOutput(nested)({ items: [{ id: 1 }, { id: 2 }] })
        .success
    ).toBe(true);
  });

  test('an unknown keyword does not reject an otherwise valid object', () => {
    // Author-written schemas carry vendor keywords the provider understands and
    // ajv does not; those must not fail a value that satisfies the rest.
    const result = validateStructuredOutput({
      type: 'object',
      'x-vendor-hint': 'whatever',
      properties: { a: { type: 'string' } },
    })({ a: 'ok' });
    expect(result.success).toBe(true);
  });

  test('an uncompilable schema accepts everything rather than failing closed', () => {
    // A schema ajv cannot compile is an authoring bug, not a bad generation.
    // Failing every generation on it would turn one bad agent config into an
    // outage; the generation proceeds unvalidated (and logs).
    const result = validateStructuredOutput({
      type: 'object',
      properties: { a: { type: 'not-a-json-schema-type' } },
    })({ anything: true });
    expect(result.success).toBe(true);
  });

  test('buildStructuredOutput returns undefined when no schema is configured', () => {
    expect(buildStructuredOutput(null)).toBeUndefined();
    expect(buildStructuredOutput(undefined)).toBeUndefined();
    expect(buildStructuredOutput('nope')).toBeUndefined();
  });
});
