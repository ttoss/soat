import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

/** Each pinned column, and the live row whose version an unpinned row takes. */
const PINS = [
  {
    table: 'orchestration_runs',
    column: 'orchestration_version',
    live: 'orchestrations',
    foreignKey: 'orchestration_id',
  },
  {
    table: 'tasks',
    column: 'workflow_version',
    live: 'workflows',
    foreignKey: 'workflow_id',
  },
] as const;

type Pin = (typeof PINS)[number];

/** The pins whose table exists and whose column still accepts null. */
const nullablePins = async (context: MigrationContext): Promise<Pin[]> => {
  const rows = await context.select<{ table_name: string }>({
    sql: `SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND (${PINS.map((pin) => {
               return `(table_name = '${pin.table}' AND column_name = '${pin.column}')`;
             }).join(' OR ')})
             AND is_nullable = 'YES'`,
  });
  return PINS.filter((pin) => {
    return rows.some((row) => {
      return row.table_name === pin.table;
    });
  });
};

const requireSql = (pin: Pin) => {
  return `
    UPDATE ${pin.table} AS t SET ${pin.column} = l.version
      FROM ${pin.live} AS l
     WHERE t.${pin.foreignKey} = l.id AND t.${pin.column} IS NULL;
    ALTER TABLE ${pin.table} ALTER COLUMN ${pin.column} SET NOT NULL;
  `;
};

/**
 * `orchestration_runs.orchestration_version` and `tasks.workflow_version` are
 * required. A row without one takes its live row's version, the graph or
 * machine it already runs on.
 */
export const pinnedVersionsRequired = defineMigration({
  name: '2026-11-24-pinned-versions-required',
  description:
    'orchestration_runs.orchestration_version and tasks.workflow_version NOT NULL; an unpinned row takes its live row version.',
  isApplied: async (context) => {
    return (await nullablePins(context)).length === 0;
  },
  up: async (context) => {
    const pins = await nullablePins(context);
    if (pins.length === 0) return;
    context.say(
      `requiring ${pins
        .map((pin) => {
          return `${pin.table}.${pin.column}`;
        })
        .join(', ')}`
    );
    await context.run({ sql: pins.map(requireSql).join('\n') });
  },
});
