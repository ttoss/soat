import { defineMigration } from '@ttoss/postgresdb';

const COLUMNS = ['pending_session_id', 'pending_actor_id'];

/**
 * The end user an ingest named, kept on its document across the async-converter
 * round trip. `sync` never alters an existing table, so the columns are a
 * migration.
 */
export const documentPendingEndUser = defineMigration({
  name: '2026-10-19-document-pending-end-user',
  description: 'pending_session_id and pending_actor_id on documents.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'documents' }))) return true;
    for (const column of COLUMNS) {
      if (!(await context.columnExists({ table: 'documents', column }))) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: 'documents' }))) return;
    for (const column of COLUMNS) {
      context.say(`adding documents.${column}`);
      await context.addColumnIfMissing({
        table: 'documents',
        column,
        type: 'varchar(255)',
      });
    }
  },
});
