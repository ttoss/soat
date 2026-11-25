import { buildPropertyComparison } from 'src/lib/formationsComparison';
import {
  mergeWithPrevious,
  normalizeDeclaredProperties,
} from 'src/lib/formationsProperties';
import { applySchemaDefaults } from 'src/lib/openapiSchemaDefaults';
import { resolveInlineSchema } from 'src/lib/openapiUnknownFields';

describe('formationsProperties', () => {
  // ── mergeWithPrevious ────────────────────────────────────────────────────

  // The predicate `plan-formation` and apply share: a whole-object comparison
  // reports a change on the first two cases, a per-key one on neither.
  describe('mergeWithPrevious', () => {
    const NODE_SCHEMA = {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              final: { type: 'boolean', default: false },
            },
          },
        },
      },
    };
    const SCHEMA = {
      type: 'object',
      properties: { definition: { allOf: [NODE_SCHEMA] } },
    };

    const merge = (args: {
      resolved: Record<string, unknown>;
      previous: Record<string, unknown>;
      lastApplied?: Record<string, unknown>;
      clearable?: string[];
      settled?: string[];
      writeOnly?: string[];
    }) => {
      return mergeWithPrevious({
        resolved: args.resolved,
        previous: args.previous,
        lastApplied: args.lastApplied ?? {},
        clearable: new Set(args.clearable),
        comparison: buildPropertyComparison({
          withSchemaDefaults: (properties) => {
            return applySchemaDefaults({
              schema: SCHEMA,
              properties,
              resolveRef: resolveInlineSchema,
            });
          },
          writeOnlyProperties: args.writeOnly ?? [],
          settled: new Set(args.settled),
        }),
      });
    };

    test('a nested value left unresolved keeps its previous value', () => {
      expect(
        merge({
          resolved: {
            auth: {
              mode: 'allowlist',
              allowlist: [{ email: undefined, role: 'admin' }],
            },
          },
          previous: {
            auth: {
              mode: 'open',
              allowlist: [{ email: 'a@x.test', role: 'member' }],
            },
          },
        }).merged
      ).toEqual({
        auth: {
          mode: 'allowlist',
          allowlist: [{ email: 'a@x.test', role: 'admin' }],
        },
      });
    });

    test('a nested value left unresolved with no previous value is dropped', () => {
      const { merged } = merge({
        resolved: { auth: { tags: ['a', undefined], email: undefined } },
        previous: { auth: { tags: ['a'] } },
      });
      expect(merged).toEqual({ auth: { tags: ['a'] } });
      expect(merged.auth).not.toHaveProperty('email');
    });

    test('a nested value left unresolved over an unchanged previous is not a change', () => {
      expect(
        merge({
          resolved: { auth: { allowlist: [{ email: undefined }] } },
          previous: { auth: { allowlist: [{ email: 'a@x.test' }] } },
        }).changed
      ).toBe(false);
    });

    test('a nested default omitted on one side is not a change', () => {
      expect(
        merge({
          resolved: { definition: { nodes: [{ id: 'a' }] } },
          previous: { definition: { nodes: [{ id: 'a', final: false }] } },
        })
      ).toEqual({
        merged: { definition: { nodes: [{ id: 'a' }] } },
        changed: false,
        snapshot: expect.any(Object),
      });
    });

    test('a nested value differing from the default is a change', () => {
      expect(
        merge({
          resolved: { definition: { nodes: [{ id: 'a' }] } },
          previous: { definition: { nodes: [{ id: 'a', final: true }] } },
        }).changed
      ).toBe(true);
    });

    test('a default is not filled into an expression', () => {
      expect(
        merge({
          resolved: { definition: { param: 'Definition' } },
          previous: { definition: { param: 'Definition' } },
        }).changed
      ).toBe(false);
    });

    test('a property declared null that the read leaves out is not a change', () => {
      expect(
        merge({
          resolved: { name: 'a', metadata: null },
          previous: { name: 'a' },
        }).changed
      ).toBe(false);
    });

    test('a property declared null over a held value is a change', () => {
      expect(
        merge({
          resolved: { name: 'a', metadata: null },
          previous: { name: 'a', metadata: { topic: 'x' } },
        }).changed
      ).toBe(true);
    });

    test.each([
      [{ text: 'hi' }, { text: 'hi', config: null }, false],
      [[{ id: 'a' }], [{ id: 'a', text: null }], false],
      [{ text: null }, { text: 'hi' }, true],
    ])('a nested null field compares as absent: %j against %j', (d, p, c) => {
      expect(merge({ resolved: { d }, previous: { d: p } }).changed).toBe(c);
    });

    test('a write-only property declared null is a change unless settled', () => {
      expect(
        merge({
          resolved: { name: 'a', auth: null },
          previous: { name: 'a' },
          writeOnly: ['auth'],
        }).changed
      ).toBe(true);
    });

    test('a settled property the previous state lacks is not a change', () => {
      expect(
        merge({
          resolved: { name: 'a', auth: { type: 'oauth' } },
          previous: { name: 'a' },
          settled: ['auth'],
        })
      ).toEqual({
        merged: { name: 'a', auth: { type: 'oauth' } },
        changed: false,
        snapshot: expect.any(Object),
      });
    });

    test('an unsettled property the previous state lacks is a change', () => {
      expect(
        merge({
          resolved: { name: 'a', auth: { type: 'oauth' } },
          previous: { name: 'a' },
        }).changed
      ).toBe(true);
    });

    test('a previous key the template omits is not a change', () => {
      expect(
        merge({
          resolved: { name: 'kept' },
          previous: { name: 'kept', description: 'set out of band' },
        })
      ).toEqual({
        merged: { name: 'kept' },
        changed: false,
        snapshot: expect.any(Object),
      });
    });

    test('key order is not a change', () => {
      expect(
        merge({
          resolved: { name: 'a', description: 'b' },
          previous: { description: 'b', name: 'a' },
        }).changed
      ).toBe(false);
    });

    test('an undefined property reuses the previous value', () => {
      expect(
        merge({
          resolved: { name: 'a', value: undefined },
          previous: { name: 'a', value: 'kept' },
        })
      ).toEqual({
        merged: { name: 'a', value: 'kept' },
        changed: false,
        snapshot: expect.any(Object),
      });
    });

    test('an undefined property with no previous value is dropped entirely', () => {
      expect(
        merge({
          resolved: { name: 'a', value: undefined },
          previous: { name: 'a' },
        })
      ).toEqual({
        merged: { name: 'a' },
        changed: false,
        snapshot: expect.any(Object),
      });
    });

    test('a differing declared value is a change', () => {
      expect(
        merge({
          resolved: { name: 'new' },
          previous: { name: 'old' },
        })
      ).toEqual({
        merged: { name: 'new' },
        changed: true,
        snapshot: expect.any(Object),
      });
    });

    test('a newly declared key is a change', () => {
      expect(
        merge({
          resolved: { name: 'a', description: 'added' },
          previous: { name: 'a' },
        }).changed
      ).toBe(true);
    });

    test('compares nested values structurally, not by identity', () => {
      expect(
        merge({
          resolved: { document: { statement: [{ effect: 'allow' }] } },
          previous: { document: { statement: [{ effect: 'allow' }] } },
        }).changed
      ).toBe(false);
    });

    test('a removed clearable key is cleared with null', () => {
      expect(
        merge({
          resolved: { name: 'a' },
          previous: { name: 'a', guardrail_ids: ['guard_1'] },
          lastApplied: { name: 'a', guardrail_ids: ['guard_1'] },
          clearable: ['guardrail_ids'],
        })
      ).toEqual({
        merged: { name: 'a', guardrail_ids: null },
        changed: true,
        snapshot: { name: 'a' },
      });
    });

    test('a removed key the module cannot clear is kept and shown', () => {
      expect(
        merge({
          resolved: { name: 'a' },
          previous: { name: 'a', trusted_output: true },
          lastApplied: { name: 'a', trusted_output: true },
        })
      ).toEqual({
        merged: { name: 'a', trusted_output: true },
        changed: false,
        snapshot: { name: 'a', trusted_output: true },
      });
    });

    test('a key never declared is not cleared', () => {
      expect(
        merge({
          resolved: { name: 'a' },
          previous: { name: 'a', guardrail_ids: ['guard_1'] },
          lastApplied: { name: 'a' },
          clearable: ['guardrail_ids'],
        })
      ).toEqual({
        merged: { name: 'a' },
        changed: false,
        snapshot: expect.any(Object),
      });
    });
  });

  // ── normalizeDeclaredProperties ──────────────────────────────────────────

  describe('normalizeDeclaredProperties', () => {
    test('rewrites top-level camelCase keys to snake_case', () => {
      expect(
        normalizeDeclaredProperties({ aiProviderId: 'aip_1', name: 'x' })
      ).toEqual({ ai_provider_id: 'aip_1', name: 'x' });
    });

    test('is idempotent on an already snake_case bag', () => {
      const snake = { ai_provider_id: 'aip_1', name: 'x' };
      expect(normalizeDeclaredProperties(snake)).toEqual(snake);
    });

    test('leaves nested bags verbatim', () => {
      const nested = { document: { Statement: [{ costCenter: 'a_b' }] } };
      expect(normalizeDeclaredProperties(nested)).toEqual(nested);
    });
  });
});
