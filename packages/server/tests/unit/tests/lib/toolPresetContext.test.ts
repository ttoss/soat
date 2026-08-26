import { DomainError } from 'src/errors';
import { coercePresetParametersToSchema } from 'src/lib/toolPresetParameters';
import { resolvePresetParameterTemplates } from 'src/lib/toolTemplates';

/**
 * `{{context:<key>}}` inside `preset_parameters` (#345). A pin is the operator's
 * fixed value for a parameter; resolving context tokens in it is what lets that
 * pin express a **per-run** boundary — the ad account a run may act on — instead
 * of a value frozen when the tool was created.
 *
 * Tested directly rather than through a route: the substitution and the
 * schema-directed coercion are pure functions over a large input space (nested
 * values, absent keys, every JSON Schema scalar type), and reaching a single
 * branch through a generation would need a whole agent + provider + tool per
 * case while reporting only "the tool call failed".
 */
describe('resolvePresetParameterTemplates', () => {
  test('substitutes a whole-value token and reports the key it resolved', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: { adAccountId: '{{context:ocaAdAccountId}}' },
      toolContext: { ocaAdAccountId: 'act_1330065197707199' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({ adAccountId: 'act_1330065197707199' });
    expect(resolved.contextResolvedKeys).toEqual(['adAccountId']);
  });

  test('substitutes a token embedded in a longer string', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: { scope: 'accounts/{{context:tenant}}/ads' },
      toolContext: { tenant: 'acme' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({ scope: 'accounts/acme/ads' });
  });

  test('walks nested objects and arrays', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: {
        filter: { accounts: ['{{context:a}}', 'act_static'], depth: 2 },
      },
      toolContext: { a: 'act_1' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({
      filter: { accounts: ['act_1', 'act_static'], depth: 2 },
    });
    expect(resolved.contextResolvedKeys).toEqual(['filter']);
  });

  test('leaves a preset with no token untouched and reports no resolved keys', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: { adAccountId: 'act_pinned', limit: 10 },
      toolContext: { ocaAdAccountId: 'act_1' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({ adAccountId: 'act_pinned', limit: 10 });
    expect(resolved.contextResolvedKeys).toEqual([]);
  });

  test('an empty-string context value is a value, not a missing key', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: { adAccountId: '{{context:empty}}' },
      toolContext: { empty: '' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({ adAccountId: '' });
  });

  test('fails closed, naming the parameter and the key, when the key is absent', () => {
    expect(() => {
      return resolvePresetParameterTemplates({
        presetParameters: { adAccountId: '{{context:ocaAdAccountId}}' },
        toolContext: { ocaToken: 'tok' },
        toolName: 'oca',
      });
    }).toThrow(
      expect.objectContaining({
        code: 'MISSING_TOOL_CONTEXT_KEY',
        message: expect.stringMatching(/adAccountId.*ocaAdAccountId/s),
      }) as unknown as Error
    );
  });

  test('distinguishes "no tool_context at all" from "one key missing"', () => {
    let thrown: unknown;
    try {
      resolvePresetParameterTemplates({
        presetParameters: { adAccountId: '{{context:ocaAdAccountId}}' },
        toolName: 'oca',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).message).toMatch(/carries no tool_context/);
  });

  test('leaves a {{secret:...}} token literal — presets are not a secret egress', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: { key: '{{secret:sec_abc123}}' },
      toolContext: { sec_abc123: 'leaked' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({ key: '{{secret:sec_abc123}}' });
  });

  test('never rescans a substituted value as template source', () => {
    const resolved = resolvePresetParameterTemplates({
      presetParameters: { key: '{{context:evil}}' },
      toolContext: { evil: '{{secret:sec_abc123}}', sec_abc123: 'leaked' },
      toolName: 'oca',
    });

    expect(resolved.values).toEqual({ key: '{{secret:sec_abc123}}' });
  });

  test('returns null presets unchanged', () => {
    expect(
      resolvePresetParameterTemplates({
        presetParameters: null,
        toolContext: { a: 'b' },
        toolName: 'oca',
      })
    ).toEqual({ values: null, contextResolvedKeys: [] });
  });
});

describe('coercePresetParametersToSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      metaAdAccountId: { type: 'integer' },
      ratio: { type: 'number' },
      dryRun: { type: 'boolean' },
      adAccountId: { type: 'string' },
    },
  };

  test('coerces a context-resolved value to the schema type', () => {
    expect(
      coercePresetParametersToSchema({
        presetParameters: {
          metaAdAccountId: '123',
          ratio: '1.5',
          dryRun: 'true',
          adAccountId: 'act_9',
        },
        contextResolvedKeys: [
          'metaAdAccountId',
          'ratio',
          'dryRun',
          'adAccountId',
        ],
        schema,
      })
    ).toEqual({
      metaAdAccountId: 123,
      ratio: 1.5,
      dryRun: true,
      adAccountId: 'act_9',
    });
  });

  test('leaves an operator-authored literal alone, even when the schema is numeric', () => {
    expect(
      coercePresetParametersToSchema({
        presetParameters: { metaAdAccountId: '123' },
        contextResolvedKeys: [],
        schema,
      })
    ).toEqual({ metaAdAccountId: '123' });
  });

  test('leaves a value the schema type cannot accept as a string', () => {
    expect(
      coercePresetParametersToSchema({
        presetParameters: { metaAdAccountId: 'act_9', dryRun: 'yes' },
        contextResolvedKeys: ['metaAdAccountId', 'dryRun'],
        schema,
      })
    ).toEqual({ metaAdAccountId: 'act_9', dryRun: 'yes' });
  });

  test('is a no-op when the schema declares nothing about the key', () => {
    expect(
      coercePresetParametersToSchema({
        presetParameters: { unknownKey: '7' },
        contextResolvedKeys: ['unknownKey'],
        schema,
      })
    ).toEqual({ unknownKey: '7' });
  });

  test('is a no-op with no schema at all', () => {
    expect(
      coercePresetParametersToSchema({
        presetParameters: { metaAdAccountId: '123' },
        contextResolvedKeys: ['metaAdAccountId'],
      })
    ).toEqual({ metaAdAccountId: '123' });
  });
});
