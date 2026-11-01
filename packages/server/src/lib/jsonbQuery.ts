import { Sequelize } from '@ttoss/postgresdb';

/**
 * A `JSON` or `JSONB` column read inside a query. `JSON` keeps the caller's key
 * order but has no `jsonb_*` function, so every read casts to `jsonb`, a no-op
 * on a `JSONB` column. Column roles: `packages/postgresdb/README.md`.
 */
export type JsonbSource =
  /** A column Sequelize quotes and qualifies. */
  | { column: string }
  /** A raw SQL expression over a column, such as `"Document"."metadata" -> 'k'`. */
  | { sql: string };

type Jsonb =
  ReturnType<typeof Sequelize.cast> | ReturnType<typeof Sequelize.literal>;

type JsonbFunction = 'extract_path' | 'extract_path_text' | 'typeof';

export const asJsonb = (args: JsonbSource): Jsonb => {
  return 'column' in args
    ? Sequelize.cast(Sequelize.col(args.column), 'jsonb')
    : Sequelize.literal(`(${args.sql})::jsonb`);
};

export const jsonbFn = (args: {
  fn: JsonbFunction;
  source: JsonbSource;
  params?: string[];
}): ReturnType<typeof Sequelize.fn> => {
  return Sequelize.fn(
    `jsonb_${args.fn}`,
    asJsonb(args.source),
    ...(args.params ?? [])
  );
};
