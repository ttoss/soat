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

const slugExists = async (args: {
  select: <T>(a: { sql: string }) => Promise<T[]>;
}): Promise<boolean> => {
  const rows = await args.select<{ count: string }>({
    sql: `SELECT count(*) AS count
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = '${ENUM_TYPE}'
             AND e.enumlabel = 'typesafe'`,
  });
  return Number(rows[0]?.count ?? 0) > 0;
};

export const aiProviderTypesafeSlug = defineMigration({
  name: '2026-09-17-ai-provider-typesafe-slug',
  description:
    "'typesafe' is added to the ai_providers.provider enum so decider credentials can be stored alongside every other provider.",
  /**
   * A fresh install has no `ai_providers` yet — the migrations run before the
   * sync that creates it, and that sync builds the enum with every slug the
   * model declares. Nothing to alter, so this is recorded rather than replayed.
   */
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'ai_providers' }))) {
      return true;
    }
    return slugExists(context);
  },
  up: async (context) => {
    context.say("adding 'typesafe' to the provider enum");
    await context.run({ sql: ADD_VALUE_SQL });
  },
});
