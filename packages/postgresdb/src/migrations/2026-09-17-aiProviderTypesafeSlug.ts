import { defineMigration } from '@ttoss/postgresdb';

/**
 * `typesafe` joins the provider slugs, so a project can hold the credential a
 * decider evaluates through.
 *
 * `sync` cannot do this: the column is a PostgreSQL `enum` type, and
 * `sequelize.sync()` creates that type only when it creates the table. An
 * existing `ai_providers` keeps the type it was built with, and inserting the
 * new slug fails on the type rather than on any constraint sequelize declares.
 */
const ENUM_TYPE = 'enum_ai_providers_provider';

const ADD_VALUE_SQL = `
  ALTER TYPE ${ENUM_TYPE} ADD VALUE IF NOT EXISTS 'typesafe';
`;

/**
 * Whether the enum type is there at all, and whether it already carries the
 * slug. The type is the subject of this migration, so it is also the probe: a
 * database without it has nothing to alter, whatever its `ai_providers` looks
 * like.
 */
const enumState = async (args: {
  select: <T>(a: { sql: string }) => Promise<T[]>;
}): Promise<{ typeExists: boolean; hasSlug: boolean }> => {
  const rows = await args.select<{ type_count: string; label_count: string }>({
    sql: `SELECT
            (SELECT count(*) FROM pg_type
              WHERE typname = '${ENUM_TYPE}') AS type_count,
            (SELECT count(*) FROM pg_enum e
               JOIN pg_type t ON t.oid = e.enumtypid
              WHERE t.typname = '${ENUM_TYPE}'
                AND e.enumlabel = 'typesafe') AS label_count`,
  });
  return {
    typeExists: Number(rows[0]?.type_count ?? 0) > 0,
    hasSlug: Number(rows[0]?.label_count ?? 0) > 0,
  };
};

export const aiProviderTypesafeSlug = defineMigration({
  name: '2026-09-17-ai-provider-typesafe-slug',
  description:
    "'typesafe' is added to the ai_providers.provider enum so decider credentials can be stored alongside every other provider.",
  /**
   * Nothing to do unless the enum type is already there.
   *
   * Migrations run *before* the sync, so a fresh install has no type yet and
   * the sync that follows builds it carrying every slug the model declares.
   * The same holds for any database whose `ai_providers` predates the enum
   * column — the table existing says nothing about the type, so the type is
   * what is probed. Either way this is recorded rather than replayed, which is
   * what keeps a new install from needing an operator `baseline`.
   */
  isApplied: async (context) => {
    const { typeExists, hasSlug } = await enumState(context);
    return !typeExists || hasSlug;
  },
  up: async (context) => {
    context.say("adding 'typesafe' to the provider enum");
    await context.run({ sql: ADD_VALUE_SQL });
  },
});
