import { defineMigration } from '@ttoss/postgresdb';

/**
 * `price_books.resource` and `price_books.quantity`: a row pricing one tool,
 * with the expression that reads its quantity off the call. Nullable, no
 * backfill: every existing row prices a SKU.
 */
const UP_SQL = `
  ALTER TABLE price_books
    ADD COLUMN IF NOT EXISTS resource varchar(128),
    ADD COLUMN IF NOT EXISTS quantity jsonb;
`;

export const priceBookResource = defineMigration({
  name: '2026-10-01-price-book-resource',
  description:
    'price_books.resource and quantity, a row pricing one tool by what a call consumed.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'price_books' }))) return true;
    return (
      (await context.columnExists({ table: 'price_books', column: 'resource' })) &&
      (await context.columnExists({ table: 'price_books', column: 'quantity' }))
    );
  },
  up: async (context) => {
    context.say('adding price_books.resource and quantity');
    await context.run({ sql: UP_SQL });
  },
});
