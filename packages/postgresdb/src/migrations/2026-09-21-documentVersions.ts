import { defineMigration } from '@ttoss/postgresdb';

/**
 * `documents.version` counts the document's content versions, the way
 * `agents.version` counts an agent's config versions.
 *
 * `sync` creates missing tables and never alters an existing one, so the
 * column is a migration; `document_versions` itself is a new table and the
 * sync builds it. Every existing document is at version 1 and has no archived
 * row, because there is nothing to archive: what it holds now is all it has
 * ever been recorded as holding.
 */
export const documentVersions = defineMigration({
  name: '2026-09-21-document-versions',
  description:
    'documents.version counts content versions, so a write can be archived and restored the way an agent config can.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'documents' }))) return true;
    return context.columnExists({ table: 'documents', column: 'version' });
  },
  up: async (context) => {
    context.say('adding documents.version');
    await context.run({
      sql: `
        ALTER TABLE documents
          ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
      `,
    });
  },
});
