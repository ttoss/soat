import { defineMigration } from '@ttoss/postgresdb';

/**
 * `conversation_messages.idempotency_digest` lets a session message refuse a
 * key reused with a different body, as generations and runs do.
 *
 * `sync` never alters an existing table, so the column is a migration.
 */
export const conversationMessageIdempotencyDigest = defineMigration({
  name: '2026-10-12-conversation-message-idempotency-digest',
  description:
    'conversation_messages.idempotency_digest, the digest of the request an idempotency key names.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'conversation_messages' }))) {
      return true;
    }
    return context.columnExists({
      table: 'conversation_messages',
      column: 'idempotency_digest',
    });
  },
  up: async (context) => {
    context.say('adding conversation_messages.idempotency_digest');
    await context.addColumnIfMissing({
      table: 'conversation_messages',
      column: 'idempotency_digest',
      type: 'varchar(64)',
    });
  },
});
