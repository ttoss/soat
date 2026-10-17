import { defineMigration } from '@ttoss/postgresdb';

/**
 * Who did a thing is a principal pair, `<verb>_principal_type` +
 * `<verb>_principal_id`, never a user foreign key: a user id cannot name the
 * API key, sweep or automation that acted, and a public id outlives the user
 * row. Each `<verb>_user_id` is backfilled as a `user` principal and dropped.
 */
const USER_COLUMNS = [
  { table: 'agent_versions', verb: 'created_by' },
  { table: 'decider_versions', verb: 'created_by' },
  { table: 'document_versions', verb: 'created_by' },
  { table: 'guardrail_versions', verb: 'created_by' },
  { table: 'orchestration_versions', verb: 'created_by' },
  { table: 'playbook_versions', verb: 'created_by' },
  { table: 'workflow_versions', verb: 'created_by' },
  { table: 'playbook_entries', verb: 'created_by' },
  { table: 'playbook_executions', verb: 'created_by' },
  { table: 'playbook_exports', verb: 'created_by' },
  { table: 'playbook_upgrades', verb: 'created_by' },
  { table: 'approval_items', verb: 'resolved_by' },
  { table: 'exception_items', verb: 'acknowledged_by' },
  { table: 'exception_items', verb: 'resolved_by' },
] as const;

type UserColumn = (typeof USER_COLUMNS)[number];

// One statement string per column, so the pair, its backfill and the drop land
// together: the probe reads the dropped column.
const pairSql = ({ table, verb }: UserColumn): string => {
  return `
  ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS ${verb}_principal_type varchar(16),
    ADD COLUMN IF NOT EXISTS ${verb}_principal_id varchar(32);
  UPDATE ${table} t
    SET ${verb}_principal_type = 'user', ${verb}_principal_id = u.public_id
    FROM users u
    WHERE u.id = t.${verb}_user_id AND t.${verb}_principal_id IS NULL;
  ALTER TABLE ${table} DROP COLUMN ${verb}_user_id;
`;
};

type Probe = {
  columnExists: (args: { table: string; column: string }) => Promise<boolean>;
};

const pendingUserColumns = async (context: Probe): Promise<UserColumn[]> => {
  const pending: UserColumn[] = [];
  for (const entry of USER_COLUMNS) {
    const column = `${entry.verb}_user_id`;
    if (await context.columnExists({ table: entry.table, column })) {
      pending.push(entry);
    }
  }
  return pending;
};

const transitionsPending = (context: Probe): Promise<boolean> => {
  return context.columnExists({
    table: 'task_transitions',
    column: 'principal_kind',
  });
};

export const principalPairs = defineMigration({
  name: '2026-10-17-principal-pairs',
  description:
    'Every user foreign key naming who acted becomes a <verb>_principal_type/_id pair; task_transitions.principal_kind becomes principal_type.',
  isApplied: async (context) => {
    return (
      (await pendingUserColumns(context)).length === 0 &&
      !(await transitionsPending(context))
    );
  },
  up: async (context) => {
    for (const entry of await pendingUserColumns(context)) {
      context.say(`${entry.table}.${entry.verb}_user_id -> principal pair`);
      await context.run({ sql: pairSql(entry) });
    }
    if (await transitionsPending(context)) {
      context.say('task_transitions.principal_kind -> principal_type');
      await context.run({
        sql: 'ALTER TABLE task_transitions RENAME COLUMN principal_kind TO principal_type;',
      });
    }
  },
});
