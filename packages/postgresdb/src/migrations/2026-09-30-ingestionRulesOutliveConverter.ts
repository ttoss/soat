import { defineMigration } from '@ttoss/postgresdb';

const CONVERTERS = [
  { column: 'tool_id', table: 'tools', publicColumn: 'tool_public_id' },
  { column: 'agent_id', table: 'agents', publicColumn: 'agent_public_id' },
] as const;

/**
 * `ingestion_rules.tool_id` and `agent_id` become `SET NULL` on delete, with
 * the converter's public id kept beside each: a rule may convert with another
 * project's shared tool or agent, whose delete must not be blocked by it.
 *
 * One statement string per column, so its constraint, column and backfill land
 * together. Each is idempotent, so a run that stopped between them is finished
 * by the next. A column the table lacks predates it and is left alone.
 */
const converterSql = (converter: (typeof CONVERTERS)[number]): string => {
  return `
  DO $$
  DECLARE fk record;
  BEGIN
    FOR fk IN
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_name = tc.table_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'ingestion_rules'
        AND kcu.column_name = '${converter.column}'
    LOOP
      EXECUTE format('ALTER TABLE ingestion_rules DROP CONSTRAINT %I', fk.constraint_name);
    END LOOP;
  END $$;
  ALTER TABLE ingestion_rules
    ADD CONSTRAINT ingestion_rules_${converter.column}_fkey FOREIGN KEY (${converter.column})
      REFERENCES ${converter.table} (id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS ${converter.publicColumn} varchar(32);
  UPDATE ingestion_rules r SET ${converter.publicColumn} = c.public_id
    FROM ${converter.table} c
    WHERE c.id = r.${converter.column} AND r.${converter.publicColumn} IS NULL;
`;
};

const convertersToChange = async (context: {
  columnExists: (args: { table: string; column: string }) => Promise<boolean>;
}): Promise<Array<(typeof CONVERTERS)[number]>> => {
  const present: Array<(typeof CONVERTERS)[number]> = [];
  for (const converter of CONVERTERS) {
    const column = { table: 'ingestion_rules', column: converter.column };
    if (await context.columnExists(column)) present.push(converter);
  }
  return present;
};

export const ingestionRulesOutliveConverter = defineMigration({
  name: '2026-09-30-ingestion-rules-outlive-converter',
  description:
    'ingestion rules keep their converter public id and survive the converter being deleted.',
  isApplied: async (context) => {
    for (const converter of await convertersToChange(context)) {
      const column = {
        table: 'ingestion_rules',
        column: converter.publicColumn,
      };
      if (!(await context.columnExists(column))) return false;
    }
    return true;
  },
  up: async (context) => {
    for (const converter of await convertersToChange(context)) {
      context.say(`keeping ${converter.publicColumn} on ingestion_rules`);
      await context.run({ sql: converterSql(converter) });
    }
  },
});
