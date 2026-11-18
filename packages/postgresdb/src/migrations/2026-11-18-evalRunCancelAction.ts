import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

/**
 * Cancelling an eval run is `evaluations:CancelEvalRun`, apart from
 * `evaluations:RunEval`. Every stored statement naming `RunEval` gains
 * `CancelEvalRun` beside it, Allow and Deny alike, so a stored grant or denial
 * covers the cancel as it did: `policies.document`, and the templates and
 * last-applied properties a formation keeps for a `policy` resource.
 */
const RUN = 'evaluations:RunEval';
const CANCEL = 'evaluations:CancelEvalRun';

const COLUMNS = [
  { table: 'policies', column: 'document' },
  { table: 'formations', column: 'template' },
  { table: 'formation_resources', column: 'last_applied_properties' },
];

/** The value with `CANCEL` after every `RUN` in an `action` list lacking it. */
const withCancel = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withCancel);
  }
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([key, item]) => {
    if (
      key === 'action' &&
      Array.isArray(item) &&
      item.includes(RUN) &&
      !item.includes(CANCEL)
    ) {
      return [
        key,
        item.flatMap((a) => {
          return a === RUN ? [RUN, CANCEL] : [a];
        }),
      ];
    }
    return [key, withCancel(item)];
  });
  return Object.fromEntries(entries);
};

const presentColumns = async (context: MigrationContext) => {
  const present: typeof COLUMNS = [];
  for (const entry of COLUMNS) {
    if (
      (await context.tableExists({ table: entry.table })) &&
      (await context.columnExists(entry))
    ) {
      present.push(entry);
    }
  }
  return present;
};

const pendingRows = async (context: MigrationContext) => {
  const pending: Array<{
    table: string;
    column: string;
    id: unknown;
    value: unknown;
  }> = [];
  for (const { table, column } of await presentColumns(context)) {
    const rows = await context.select<{ id: unknown; value: unknown }>({
      sql: `SELECT id, ${column} AS value FROM ${table}
            WHERE strpos(${column}::text, '"${RUN}"') > 0`,
    });
    for (const row of rows) {
      const value = withCancel(row.value);
      if (JSON.stringify(value) !== JSON.stringify(row.value)) {
        pending.push({ table, column, id: row.id, value });
      }
    }
  }
  return pending;
};

export const evalRunCancelAction = defineMigration({
  name: '2026-11-18-eval-run-cancel-action',
  description:
    'evaluations:CancelEvalRun beside every evaluations:RunEval in a stored policy document: policies and stored formation templates.',
  isApplied: async (context) => {
    return (await pendingRows(context)).length === 0;
  },
  up: async (context) => {
    const pending = await pendingRows(context);
    context.say(`adding ${CANCEL} to ${pending.length} stored documents`);
    if (pending.length === 0) return;
    // One statement, so no document is left without the action.
    const touched = COLUMNS.filter(({ table }) => {
      return pending.some((row) => {
        return row.table === table;
      });
    });
    const updates = touched.map(({ table, column }, index) => {
      return `u${index} AS (UPDATE ${table} t SET ${column} = i.value::json
        FROM input i WHERE i.tbl = '${table}' AND t.id::text = i.id RETURNING 1)`;
    });
    await context.run({
      sql: `WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(tbl text, id text, value text)
        ), ${updates.join(', ')} SELECT 1`,
      values: [
        JSON.stringify(
          pending.map(({ table, id, value }) => {
            return { tbl: table, id: String(id), value: JSON.stringify(value) };
          })
        ),
      ],
    });
  },
});
