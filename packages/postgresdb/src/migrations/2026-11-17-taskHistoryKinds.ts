import { defineMigration } from '@ttoss/postgresdb';

/**
 * `task_transitions.kind` and `related_task_id`, and `to_state` nullable, so
 * a history row can record a dependency added or removed, which moves no
 * state. A row carrying workflow versions is a migration. One statement
 * string, so `kind` never lands without its backfill.
 */
const UP_SQL = `
  ALTER TABLE task_transitions
    ALTER COLUMN to_state DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS kind varchar(32) NOT NULL DEFAULT 'transition',
    ADD COLUMN IF NOT EXISTS related_task_id varchar(32);
  UPDATE task_transitions SET kind = 'migration'
   WHERE kind = 'transition' AND to_workflow_version IS NOT NULL;
`;

const TO_STATE_NOT_NULL_SQL = `
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'task_transitions'
     AND column_name = 'to_state' AND is_nullable = 'NO'
`;

export const taskHistoryKinds = defineMigration({
  name: '2026-11-17-task-history-kinds',
  description:
    'task_transitions.kind (backfilled) and related_task_id, and to_state nullable, for dependency history rows.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'task_transitions' }))) {
      return true;
    }
    const held = await context.select({ sql: TO_STATE_NOT_NULL_SQL });
    return (
      held.length === 0 &&
      (await context.columnExists({
        table: 'task_transitions',
        column: 'kind',
      })) &&
      (await context.columnExists({
        table: 'task_transitions',
        column: 'related_task_id',
      }))
    );
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: 'task_transitions' }))) return;
    context.say(
      'adding task_transitions.kind and related_task_id, making to_state nullable'
    );
    await context.run({ sql: UP_SQL });
  },
});
