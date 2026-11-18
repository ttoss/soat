import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

/**
 * Every alias of every provider, one row each. A `model_aliases` that is not
 * an object reads as empty, so a malformed value never fails the migration.
 */
const ALIASES = `aliases AS (
  SELECT p.id AS ai_provider_id, a.key AS alias, a.value AS vendor_model
  FROM ai_providers p,
    json_each_text(CASE WHEN json_typeof(p.model_aliases::json) = 'object'
      THEN p.model_aliases::json ELSE '{}'::json END) a
  WHERE p.model_aliases IS NOT NULL
)`;

/** Each vendor id an alias targets, with how many aliases target it. */
const TARGETS = `targets AS (
  SELECT ai_provider_id, vendor_model, min(alias) AS alias,
    count(*) AS aliases
  FROM aliases GROUP BY ai_provider_id, vendor_model
)`;

/** An event already under one of its provider's aliases keeps it. */
const NOT_AN_ALIAS = `NOT EXISTS (
  SELECT 1 FROM aliases n
  WHERE n.ai_provider_id = e.ai_provider_id AND n.alias = e.model
)`;

const countOf = (args: { context: MigrationContext; where: string }) => {
  return args.context.countOf({
    sql: `WITH ${ALIASES}, ${TARGETS}
SELECT count(*) FROM usage_events e
WHERE e.ai_provider_id IN (SELECT ai_provider_id FROM aliases)
  AND ${NOT_AN_ALIAS} AND ${args.where}`,
  });
};

const RENAMABLE = `EXISTS (SELECT 1 FROM targets t
  WHERE t.ai_provider_id = e.ai_provider_id AND t.vendor_model = e.model
    AND t.aliases = 1)`;

const AMBIGUOUS = `EXISTS (SELECT 1 FROM targets t
  WHERE t.ai_provider_id = e.ai_provider_id AND t.vendor_model = e.model
    AND t.aliases > 1)`;

const UNALIASED = `NOT EXISTS (SELECT 1 FROM targets t
  WHERE t.ai_provider_id = e.ai_provider_id AND t.vendor_model = e.model)`;

const carries = async (args: { context: MigrationContext }) => {
  const { context } = args;
  return (
    (await context.columnExists({
      table: 'ai_providers',
      column: 'model_aliases',
    })) &&
    (await context.columnExists({
      table: 'usage_events',
      column: 'ai_provider_id',
    }))
  );
};

/**
 * Names a usage event recorded under a vendor model id by the alias of its
 * provider that targets that id, so every event reads under the provider's
 * public name. An id two aliases target is ambiguous and stays; only `model`
 * is written.
 */
export const usageEventModelAliases = defineMigration({
  name: '2026-11-18-usage-event-model-aliases',
  description:
    'Usage events under a vendor model id renamed to the one alias of their provider that targets it; ambiguous and unaliased ids kept.',
  isApplied: async (context) => {
    if (!(await carries({ context }))) return true;
    return (await countOf({ context, where: RENAMABLE })) === 0;
  },
  up: async (context) => {
    if (!(await carries({ context }))) return;
    const [renamable, ambiguous, unaliased] = [
      await countOf({ context, where: RENAMABLE }),
      await countOf({ context, where: AMBIGUOUS }),
      await countOf({ context, where: UNALIASED }),
    ];
    context.say(
      `renaming ${renamable} usage events to their provider's alias; keeping ${ambiguous} ambiguous and ${unaliased} unaliased`
    );
    await context.run({
      sql: `WITH ${ALIASES}, ${TARGETS}
UPDATE usage_events e SET model = t.alias
FROM targets t
WHERE t.ai_provider_id = e.ai_provider_id AND t.vendor_model = e.model
  AND t.aliases = 1 AND ${NOT_AN_ALIAS};`,
    });
  },
});
