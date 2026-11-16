import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

const storedError = (args: { work: string }) => {
  return `json_build_object(
      'code', 'WORK_AUTHORITY_MISSING',
      'message', ${args.work} || ' has no stored authority to run under.',
      'meta', json_build_object('work', ${args.work}))`;
};

/**
 * Each kind of work, the statuses it ends in, and how an unfinished row
 * without authority is ended. Matching by terminal status ends a status this
 * list does not know rather than leaving it to wait forever.
 */
const WORK = [
  {
    table: 'generations',
    columns: ['status', 'stop_reason', 'completed_at', 'error', 'updated_at'],
    terminal: ['completed', 'failed'],
    end: `status = 'failed', stop_reason = 'error', completed_at = now(),
  error = ${storedError({ work: `'Generation ''' || public_id || ''''` })}`,
  },
  {
    table: 'orchestration_runs',
    columns: ['status', 'wake_at', 'completed_at', 'error', 'updated_at'],
    terminal: ['completed', 'failed', 'cancelled', 'expired'],
    end: `status = 'expired', wake_at = NULL, completed_at = now(),
  error = ${storedError({ work: `'Orchestration run ''' || public_id || ''''` })}`,
  },
  {
    table: 'playbook_executions',
    columns: [
      'status',
      'lease_expires_at',
      'finished_at',
      'error',
      'updated_at',
    ],
    terminal: ['completed', 'failed'],
    end: `status = 'failed', lease_expires_at = NULL, finished_at = now(),
  error = ${storedError({ work: `'Playbook execution ''' || public_id || ''''` })}`,
  },
  {
    // A task stores no error: it closes in the state it waited in.
    table: 'tasks',
    columns: ['status', 'stall_deadline_at', 'updated_at'],
    terminal: ['closed'],
    end: `status = 'closed', stall_deadline_at = NULL`,
  },
];

type Work = (typeof WORK)[number];

/** Whether the table is the one this migration ends rows of. */
const carries = async (args: {
  context: MigrationContext;
  work: Work;
}): Promise<boolean> => {
  const { context, work } = args;
  if (!(await context.tableExists({ table: work.table }))) return false;
  for (const column of work.columns) {
    if (!(await context.columnExists({ table: work.table, column }))) {
      return false;
    }
  }
  return true;
};

const unfinished = (args: { terminal: string[] }) => {
  const list = args.terminal
    .map((status) => {
      return `'${status}'`;
    })
    .join(', ');
  return `authority IS NULL AND status::text NOT IN (${list})`;
};

/**
 * Ends every unfinished generation, orchestration run, playbook execution and
 * task that holds no stored authority: such work is refused
 * (`WORK_AUTHORITY_MISSING`) and can never resume. Finished rows are kept as
 * they are; no authority is backfilled.
 */
export const expireWorkWithoutAuthority = defineMigration({
  name: '2026-11-16-expire-work-without-authority',
  description:
    'Unfinished generations, orchestration runs, playbook executions and tasks without stored authority ended as failed, expired or closed.',
  isApplied: async (context) => {
    for (const work of WORK) {
      if (!(await carries({ context, work }))) continue;
      if (
        !(await context.columnExists({
          table: work.table,
          column: 'authority',
        }))
      ) {
        return false;
      }
      const open = await context.countOf({
        sql: `SELECT count(*) FROM ${work.table} WHERE ${unfinished(work)}`,
      });
      if (open > 0) return false;
    }
    return true;
  },
  up: async (context) => {
    context.say('ending unfinished work that holds no stored authority');
    const statements: string[] = [];
    for (const work of WORK) {
      if (!(await carries({ context, work }))) continue;
      if (
        !(await context.columnExists({
          table: work.table,
          column: 'authority',
        }))
      ) {
        continue;
      }
      statements.push(
        `UPDATE ${work.table} SET ${work.end}, updated_at = now()
WHERE ${unfinished(work)};`
      );
    }
    if (statements.length === 0) return;
    await context.run({ sql: statements.join('\n') });
  },
});
