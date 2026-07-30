import { Sequelize } from '@ttoss/postgresdb';

// `dist`, not `src`, for the same reason as `modelIndexes.test.ts`: Babel's
// TypeScript transform rejects a decorated `declare` field, so the models can
// only be loaded from the compiled artifact. `turbo run test` depends on
// `build`; run `pnpm build` first when running this suite directly.
import { models, RETIRED_INDEX_NAMES } from '../../../dist/index.cjs';

/**
 * The list is only safe because of one invariant: **a retired name is never a
 * name a model still declares.** `dropRetiredIndexes` drops every name in the
 * list unconditionally, so an overlap would drop a live index — `sync` would
 * re-create it on the next boot, and the two would fight forever.
 *
 * These checks need no database, so they run on every `pnpm test` regardless of
 * whether Docker is available. `schemaDrift.test.ts` covers what only a real
 * catalog can answer.
 */
const modelList = Object.values(models);

// Registering the models resolves decorator metadata into `options.indexes`,
// including the names Sequelize *derives* for entries that omit `name:` — which
// is exactly the generation-2 form this list is full of, so the comparison has
// to see them. No connection is opened.
new Sequelize({
  dialect: 'postgres',
  define: { underscored: true },
  models: modelList,
});

const declaredIndexNames = new Set<string>(
  modelList.flatMap((model) => {
    return (model.options.indexes ?? [])
      .map((index: { name?: string }) => {
        return index.name;
      })
      .filter((name: string | undefined): name is string => {
        return Boolean(name);
      });
  })
);

describe('RETIRED_INDEX_NAMES', () => {
  test('the fixture resolves to real models and a non-empty list', () => {
    expect(modelList.length).toBeGreaterThan(0);
    expect(declaredIndexNames.size).toBeGreaterThan(0);
    expect(RETIRED_INDEX_NAMES.length).toBeGreaterThan(0);
  });

  test('no retired name is still declared by a model', () => {
    const overlap = RETIRED_INDEX_NAMES.filter((name: string) => {
      return declaredIndexNames.has(name);
    });

    expect(overlap).toEqual([]);
  });

  test('contains no duplicates', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const name of RETIRED_INDEX_NAMES) {
      if (seen.has(name)) {
        duplicates.push(name);
      }

      seen.add(name);
    }

    expect(duplicates).toEqual([]);
  });

  test('every name fits Postgres’s 63-character identifier limit', () => {
    // A longer entry could never match a catalog row: Postgres truncates on
    // create, so the stored name is at most 63 characters and the drop would
    // silently never fire.
    const offenders = RETIRED_INDEX_NAMES.filter((name: string) => {
      return name.length === 0 || name.length > 63;
    });

    expect(offenders).toEqual([]);
  });

  test('lists the three naming generations observed in production', () => {
    // `usage_events` carried all three at once, which is what proved `sync`
    // never drops anything. Generation 3 (`..._unique`) is the live name and
    // must be absent — the assertion above forbids it, this one pins the two
    // dead generations as present.
    expect(RETIRED_INDEX_NAMES).toContain('usage_events_idempotency_key_key');
    expect(RETIRED_INDEX_NAMES).toContain('usage_events_idempotency_key');
    expect(declaredIndexNames.has('usage_events_idempotency_key_unique')).toBe(
      true
    );
  });

  test('lists the pre-#561 price_books grain that rejects valid rows', () => {
    // The 5-column predecessors of `price_books_scope_sku_component_effective_uk`.
    // Both omit `component`, so while they exist a project- and provider-scoped
    // price book cannot hold both an `input_tokens` and an `output_tokens` row.
    expect(RETIRED_INDEX_NAMES).toContain(
      'price_books_ai_provider_id_project_id_provider_model_effective_'
    );
    expect(RETIRED_INDEX_NAMES).toContain(
      'price_books_provider_model_effective_uk'
    );
  });
});
