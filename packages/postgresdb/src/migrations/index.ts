import type { Migration } from '@ttoss/postgresdb';

import { memoriesRenameAndProvenance } from './memoriesRenameAndProvenance';
import { memoryTagsToJsonb } from './memoryTagsToJsonb';

/**
 * The schema changes `sync` cannot make, in the order they run. Order is a
 * contract — a later migration may assume an earlier one has happened, and
 * nothing may assume the reverse. Here the rename meets tables whose `tags`
 * column the first migration has already converted.
 *
 * A name is the migration's identity in the ledger and is permanent: renaming
 * or removing one that has run anywhere leaves the ledger holding a name
 * nothing declares, and the runner refuses to start.
 *
 * Every entry declares `isApplied`, so adopting the ledger needs no operator
 * step — a database that already carries a change records it rather than
 * replaying it. `tests/unit/tests/migrations.test.ts` enforces that.
 */
export const MIGRATIONS: Migration[] = [
  memoryTagsToJsonb,
  memoriesRenameAndProvenance,
];
