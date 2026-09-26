import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:usage');

/**
 * The records the runtime writes about work it did, per table, in bytes. They
 * are a side effect of work rather than something a caller stored, which is
 * what keeps them out of `gb_day` and the `storage_bytes` quota it enforces.
 */
export type RecordFootprint = {
  generations: number;
  traces: number;
  usageEvents: number;
  auditEntries: number;
  activityEntries: number;
  total: number;
};

/** Structural, like `FinderModel` in `resourceAccessor.ts`. `field` is the
 * column name, which Sequelize sets on every attribute at init. */
type ColumnedModel = {
  getAttributes: () => Record<string, { field?: string }>;
};

/**
 * Every column of the model, summed at its stored width. Derived from the model
 * so a column added later is measured without anyone listing it.
 *
 * `pg_column_size` on a column reads an out-of-line value's size from its TOAST
 * pointer without fetching it; a whole-row `pg_column_size(t.*)` would
 * detoast every transcript to build the composite. A null column is null, so
 * each term is coalesced or it would void the row's sum.
 */
const rowWidth = (args: { model: ColumnedModel; alias: string }) => {
  return Object.values(args.model.getAttributes())
    .map((attribute) => {
      return `COALESCE(pg_column_size(${args.alias}."${attribute.field}"), 0)`;
    })
    .join(' + ');
};

// Every term is an aggregate over a one-row derived table, so the statement
// always returns exactly one numeric row. `numeric` arrives as a string.
const readRecordFootprint = (rows: unknown[]): RecordFootprint => {
  const [row] = rows as Array<Record<string, string | number>>;
  const generations = Number(row.generation_bytes);
  const traces = Number(row.trace_bytes);
  const usageEvents =
    Number(row.usage_event_bytes) + Number(row.usage_component_bytes);
  const auditEntries = Number(row.audit_entry_bytes);
  const activityEntries = Number(row.activity_entry_bytes);
  return {
    generations,
    traces,
    usageEvents,
    auditEntries,
    activityEntries,
    total: generations + traces + usageEvents + auditEntries + activityEntries,
  };
};

/**
 * Column bytes as stored, like `gb_day`'s JSONB terms: tuple headers, index
 * pages and bloat are not attributable to one project and are excluded. Trace steps are not a term:
 * they are stored as a file under `/.system/traces/`, which `gb_day` already
 * sums, so the two components never count a byte twice.
 *
 * An audit entry with no project is the deployment's, not a project's.
 */
export const projectRecordFootprint = async (args: {
  projectId: number;
}): Promise<RecordFootprint> => {
  log('projectRecordFootprint: projectId=%d', args.projectId);
  const [rows] = await db.sequelize.query(
    `SELECT generations.generation_bytes,
            traces.trace_bytes,
            usage_events.usage_event_bytes,
            usage_components.usage_component_bytes,
            audit_entries.audit_entry_bytes,
            activity_entries.activity_entry_bytes
       FROM (SELECT COALESCE(SUM(${rowWidth({ model: db.Generation, alias: 'g' })}), 0) AS generation_bytes
               FROM "generations" g
              WHERE g."project_id" = :projectId) generations
       CROSS JOIN
            (SELECT COALESCE(SUM(${rowWidth({ model: db.Trace, alias: 't' })}), 0) AS trace_bytes
               FROM "traces" t
              WHERE t."project_id" = :projectId) traces
       CROSS JOIN
            (SELECT COALESCE(SUM(${rowWidth({ model: db.UsageEvent, alias: 'ue' })}), 0) AS usage_event_bytes
               FROM "usage_events" ue
              WHERE ue."project_id" = :projectId) usage_events
       CROSS JOIN
            (SELECT COALESCE(SUM(${rowWidth({ model: db.UsageComponent, alias: 'uc' })}), 0) AS usage_component_bytes
               FROM "usage_components" uc
               JOIN "usage_events" ue ON uc."usage_event_id" = ue."id"
              WHERE ue."project_id" = :projectId) usage_components
       CROSS JOIN
            (SELECT COALESCE(SUM(${rowWidth({ model: db.AuditEntry, alias: 'ae' })}), 0) AS audit_entry_bytes
               FROM "audit_entries" ae
              WHERE ae."project_id" = :projectId) audit_entries
       CROSS JOIN
            (SELECT COALESCE(SUM(${rowWidth({ model: db.ActivityEntry, alias: 'act' })}), 0) AS activity_entry_bytes
               FROM "activity_entries" act
              WHERE act."project_id" = :projectId) activity_entries`,
    { replacements: { projectId: args.projectId } }
  );
  return readRecordFootprint(rows);
};
